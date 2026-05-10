/**
 * Crossplay server entrypoint.
 *
 * Three concerns, in order:
 *   1. Boot Fastify with the multipart and websocket plugins, register
 *      the ws route at `/ws/puzzles/:id`.
 *   2. Scan `GAME_DIR` for `.puz` files and load them into the in‑memory
 *      store (slugified filenames are the puzzle ids).
 *   3. Mount REST routes under `/api` and — only in production — serve
 *      the built client static files with an SPA fallback so deep links
 *      like `/p/<id>` resolve to `index.html`.
 *
 * In dev, Vite serves the client and proxies `/api` and `/ws` here
 * unchanged, so the same paths work in both modes.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import multipart from "@fastify/multipart";
import staticPlugin from "@fastify/static";
import websocket from "@fastify/websocket";
import { parsePuzBuffer } from "./puzzle.js";
import { IpuzUnsupportedError, parseIpuzBuffer, writeIpuz } from "./ipuz.js";
import { getPuzzle, putPuzzle } from "./store.js";
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

await app.register(multipart, {
  limits: { fileSize: 5 * 1024 * 1024 },
});
await app.register(websocket);
registerWsRoutes(app);

// Load a library of pre-existing .puz files from GAME_DIR (if set).
// Defaults to the fixture dir so a fresh checkout has playable games.
const here = dirname(fileURLToPath(import.meta.url));
const fixtureDir = resolve(here, "..", "fixtures");
const GAME_DIR = process.env.GAME_DIR ?? fixtureDir;

/** Lowercase, replace non-alphanumeric runs with `-`, trim. Empty input
 *  becomes the literal string "game". Used to turn `.puz` filenames into
 *  URL-safe puzzle ids. */
function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "game"
  );
}

/** Read a puzzle file from disk, parse it, and put it into the store
 *  under `id`. Returns `false` and logs a warning on any failure (so a
 *  single malformed file doesn't abort library load). */
function loadGame(id: string, path: string, format: PuzzleFormat): boolean {
  try {
    const buf = readFileSync(path);
    const parsed = parsePuzzleBuffer(id, buf, format);
    putPuzzle(id, parsed);
    return true;
  } catch (err) {
    app.log.warn({ err, path, id }, "skipping unreadable puzzle");
    return false;
  }
}

const LIBRARY_EXT = /\.(puz|ipuz)$/i;

const libraryIds: string[] = [];
try {
  const entries = readdirSync(GAME_DIR);
  const seen = new Set<string>();
  for (const entry of entries) {
    const m = entry.match(LIBRARY_EXT);
    if (!m) continue;
    const format = m[1]!.toLowerCase() === "ipuz" ? "ipuz" : "puz";
    const base = entry.replace(LIBRARY_EXT, "");
    let id = slugify(base);
    let n = 2;
    while (seen.has(id)) {
      id = `${slugify(base)}-${n++}`;
    }
    seen.add(id);
    if (loadGame(id, resolve(GAME_DIR, entry), format)) libraryIds.push(id);
  }
  app.log.info({ path: GAME_DIR, count: libraryIds.length }, "loaded game library");
} catch (err) {
  app.log.warn({ err, path: GAME_DIR }, "could not read GAME_DIR");
}

// All HTTP API routes mounted under /api so they don't collide with
// SPA routes when the server also serves the built client.
await app.register(
  async (api) => {
    api.get("/health", async () => ({ ok: true }));

    api.get("/games", async () => {
      const out: Array<{
        id: string;
        title: string;
        author: string;
        width: number;
        height: number;
      }> = [];
      for (const id of libraryIds) {
        const entry = getPuzzle(id);
        if (!entry) continue;
        const m = entry.state.meta;
        out.push({
          id,
          title: m.title,
          author: m.author,
          width: m.width,
          height: m.height,
        });
      }
      return out;
    });

    api.post("/puzzles", async (req, reply) => {
      const file = await req.file();
      if (!file) {
        return reply.code(400).send({ error: "missing file" });
      }
      const buffer = await file.toBuffer();
      const id = randomUUID();
      const format = detectFormat(file.filename, buffer);
      try {
        const parsed = parsePuzzleBuffer(id, buffer, format);
        putPuzzle(id, parsed);
        return { puzzleId: id };
      } catch (err) {
        req.log.error({ err, format }, "failed to parse puzzle upload");
        if (err instanceof IpuzUnsupportedError) {
          return reply.code(400).send({ error: err.message });
        }
        return reply.code(400).send({ error: `invalid .${format} file` });
      }
    });

    api.get<{ Params: { id: string } }>("/puzzles/:id", async (req, reply) => {
      const entry = getPuzzle(req.params.id);
      if (!entry) return reply.code(404).send({ error: "not found" });
      return entry.state;
    });

    api.get<{ Params: { id: string } }>("/puzzles/:id/ipuz", async (req, reply) => {
      const entry = getPuzzle(req.params.id);
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

const port = Number(process.env.PORT ?? 3001);
const host = process.env.HOST ?? "127.0.0.1";
app.listen({ port, host }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
