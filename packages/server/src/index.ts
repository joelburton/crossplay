/**
 * Crossplay server entrypoint.
 *
 * Three concerns, in order:
 *   1. Boot Fastify with the multipart and websocket plugins, register
 *      the ws route at `/ws/boards/:id`.
 *   2. Open the SQLite handle, run any pending migrations, and hydrate
 *      the in-memory `store.ts` from the `puzzles` table so existing
 *      play/ws routes keep working. (The in-memory store is a temporary
 *      step on the way to fully DB-backed boards in later sprint steps.)
 *   3. Mount REST routes under `/api` and — only in production — serve
 *      the built client static files with an SPA fallback so deep links
 *      like `/b/<id>` resolve to `index.html`.
 *
 * In dev, Vite serves the client and proxies `/api` and `/ws` here
 * unchanged, so the same paths work in both modes.
 */

import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import multipart from "@fastify/multipart";
import staticPlugin from "@fastify/static";
import websocket from "@fastify/websocket";
import { parsePuzBuffer } from "./puzzle.js";
import { IpuzUnsupportedError, parseIpuzBuffer, writeIpuz } from "./ipuz.js";
import { closeDb, getDb } from "./db.js";
import { flushAll, getOrLoadBoard } from "./store.js";
import { slugify } from "./importer.js";
import {
  PuzzleNotFoundError,
  findOrCreateBoard,
  getBoardState,
  listBoards,
} from "./boards.js";
import { registerWsRoutes } from "./ws.js";

type PuzzleFormat = "puz" | "ipuz";

/** Pick a parser. Extension wins; otherwise sniff for a leading `{`
 *  (BOM-tolerant) and treat as ipuz, else fall back to .puz. */
function detectFormat(filename: string | undefined, buffer: Buffer): PuzzleFormat {
  const ext = filename?.toLowerCase().match(/\.(puz|ipuz)$/)?.[1];
  if (ext === "ipuz") return "ipuz";
  if (ext === "puz") return "puz";
  let i = 0;
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) i = 3;
  while (i < buffer.length && (buffer[i] === 0x20 || buffer[i] === 0x09 || buffer[i] === 0x0a || buffer[i] === 0x0d)) i++;
  return buffer[i] === 0x7b ? "ipuz" : "puz"; // '{'
}

function parsePuzzleBuffer(id: string, buffer: Buffer, format: PuzzleFormat) {
  return format === "ipuz" ? parseIpuzBuffer(id, buffer) : parsePuzBuffer(id, buffer);
}

const app = Fastify({ logger: true });

// Open the SQLite handle + run any pending migrations. Eager so a
// migration error fails boot instead of surfacing on first DB use.
const db = getDb();
app.log.info({ schemaVersion: (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version }, "sqlite ready");

await app.register(multipart, {
  limits: { fileSize: 5 * 1024 * 1024 },
});
await app.register(websocket);
registerWsRoutes(app, { db });

const here = dirname(fileURLToPath(import.meta.url));

// All HTTP API routes mounted under /api so they don't collide with
// SPA routes when the server also serves the built client.
await app.register(
  async (api) => {
    api.get("/health", async () => ({ ok: true }));

    api.get("/puzzles", async () => {
      // Read directly from the table — denormalized columns mean no
      // ipuz parse needed for the list view. Newest first so freshly
      // imported puzzles surface at the top.
      return db
        .prepare(
          "SELECT id, title, author, width, height FROM puzzles ORDER BY created_at DESC",
        )
        .all() as Array<{
        id: string;
        title: string;
        author: string;
        width: number;
        height: number;
      }>;
    });

    api.post("/boards/upload", async (req, reply) => {
      // Ad-hoc upload: parse the file and create a board directly with
      // no puzzle row (puzzle_id IS NULL). The puzzles table stays
      // CLI-only — uploads are how *players* bring a one-off file to
      // play, not how the curated library grows.
      const file = await req.file();
      if (!file) {
        return reply.code(400).send({ error: "missing file" });
      }
      const buffer = await file.toBuffer();
      const id = randomUUID();
      const format = detectFormat(file.filename, buffer);
      try {
        const parsed = parsePuzzleBuffer(id, buffer, format);
        const ipuz = writeIpuz(parsed.state, parsed.solution);
        const meta = parsed.state.meta;
        const snapshot = JSON.stringify(parsed.state.snapshot);
        const now = new Date().toISOString();
        db.prepare(
          "INSERT INTO boards (id, puzzle_id, ipuz, title, author, snapshot, chat, created_at, updated_at) VALUES (?, NULL, ?, ?, ?, ?, '[]', ?, ?)",
        ).run(id, ipuz, meta.title, meta.author, snapshot, now, now);
        // No in-memory mirror: the first WS connect to this board will
        // lazy-load it via getOrLoadBoard.
        return { boardId: id };
      } catch (err) {
        req.log.error({ err, format }, "failed to parse uploaded board");
        if (err instanceof IpuzUnsupportedError) {
          return reply.code(400).send({ error: err.message });
        }
        return reply.code(400).send({ error: `invalid .${format} file` });
      }
    });

    api.post<{ Body: { puzzleId?: string } }>("/boards", async (req, reply) => {
      const puzzleId = req.body?.puzzleId;
      if (!puzzleId || typeof puzzleId !== "string") {
        return reply.code(400).send({ error: "missing puzzleId" });
      }
      try {
        const { boardId } = findOrCreateBoard(db, puzzleId);
        // No in-memory mirror: the first WS connect to this board will
        // lazy-load it via getOrLoadBoard.
        return { boardId };
      } catch (err) {
        if (err instanceof PuzzleNotFoundError) {
          return reply.code(404).send({ error: err.message });
        }
        throw err;
      }
    });

    api.get("/boards", async () => listBoards(db));

    api.get<{ Params: { id: string } }>("/boards/:id", async (req, reply) => {
      const state = getBoardState(db, req.params.id);
      if (!state) return reply.code(404).send({ error: "not found" });
      return state;
    });

    api.get<{ Params: { id: string } }>("/boards/:id/ipuz", async (req, reply) => {
      // Download a board (the player's current state) as canonical ipuz.
      // Lazy-load via the in-memory cache so an active board reflects
      // any in-flight fills; an idle board falls through to the DB row.
      const entry = getOrLoadBoard(db, req.params.id);
      if (!entry) return reply.code(404).send({ error: "not found" });
      const json = writeIpuz(entry.state, entry.solution);
      const stem = slugify(entry.state.meta.title) || entry.state.meta.id;
      reply
        .header("content-type", "application/json; charset=utf-8")
        .header("content-disposition", `attachment; filename="${stem}.ipuz"`);
      return json;
    });
  },
  { prefix: "/api" },
);

// Production-only: serve the built client and route SPA paths to index.html.
// Dev mode (Vite) doesn't need this — Vite serves the client itself and
// proxies /api + /ws to this server.
const isProd = process.env.NODE_ENV === "production";
const clientDist =
  process.env.CLIENT_DIST ?? resolve(here, "..", "..", "client", "dist");
if (isProd) {
  if (!existsSync(clientDist)) {
    app.log.error({ clientDist }, "CLIENT_DIST does not exist; run `npm run build` first");
    process.exit(1);
  }
  await app.register(staticPlugin, { root: clientDist });
  app.setNotFoundHandler((req, reply) => {
    // SPA fallback: GET (page navigation) or HEAD (link previews,
    // monitoring probes) for non-API/WS paths return index.html so the
    // client router handles the route. Everything else 404s.
    if (req.method !== "GET" && req.method !== "HEAD") {
      return reply.code(404).send({ error: "not found" });
    }
    if (req.url.startsWith("/api/") || req.url.startsWith("/ws/")) {
      return reply.code(404).send({ error: "not found" });
    }
    return reply.sendFile("index.html");
  });
  app.log.info({ clientDist }, "serving client static files");
}

// Drain dirty cached boards on graceful shutdown so a clean SIGTERM
// (e.g. nginx reload, manual ctrl-c in dev) doesn't lose play progress.
// We register the listener once; if both signals fire, the second is
// ignored. Errors during shutdown are logged but don't block exit —
// any unflushed work is already lost at that point.
let shuttingDown = false;
async function shutdown(signal: NodeJS.Signals) {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, "shutdown: flushing dirty boards");
  try {
    flushAll(db);
  } catch (err) {
    app.log.error({ err }, "shutdown: flushAll failed");
  }
  try {
    await app.close();
  } catch (err) {
    app.log.error({ err }, "shutdown: app.close failed");
  }
  try {
    closeDb();
  } catch (err) {
    app.log.error({ err }, "shutdown: closeDb failed");
  }
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

const port = Number(process.env.PORT ?? 3001);
const host = process.env.HOST ?? "127.0.0.1";
app.listen({ port, host }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
