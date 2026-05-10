/**
 * HTTP route registrar. Mirrors `registerWsRoutes` in shape: takes a
 * Fastify instance plus a db handle and mounts every `/api/*` route.
 * Pulled out of `index.ts` so tests can drive the routes via
 * `app.inject()` without booting the full server (port listen, signal
 * handlers, prod static).
 *
 * Callers are responsible for registering `@fastify/multipart` first —
 * the upload route depends on it.
 */

import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { FastifyInstance } from "fastify";
import { IpuzUnsupportedError, writeIpuz } from "./ipuz.js";
import { evictBoard, getCachedBoard, getOrLoadBoard } from "./store.js";
import { slugify } from "./importer.js";
import { detectFormat, parsePuzzleBuffer } from "./format.js";
import {
  PuzzleNotFoundError,
  deleteBoard,
  findOrCreateBoard,
  getBoardState,
  insertBoardRow,
  listBoards,
} from "./boards.js";

export type HttpRouteOptions = {
  /** Shared sqlite handle. */
  db: DatabaseSync;
};

/** Mount every `/api/*` route on the given Fastify instance. */
export async function registerHttpRoutes(app: FastifyInstance, opts: HttpRouteOptions): Promise<void> {
  const { db } = opts;
  await app.register(
    async (api) => {
      api.get("/health", async () => ({ ok: true }));

      api.get("/puzzles", async () => {
        // Read directly from the table — denormalized columns mean no
        // ipuz parse needed for the list view. Newest first so freshly
        // imported puzzles surface at the top.
        return db
          .prepare(
            "SELECT id, title, author, copyright, width, height FROM puzzles ORDER BY created_at DESC",
          )
          .all() as Array<{
          id: string;
          title: string;
          author: string;
          copyright: string;
          width: number;
          height: number;
        }>;
      });

      api.post("/boards/upload", async (req, reply) => {
        // Ad-hoc upload: parse the file and create a board directly with
        // no puzzle row (puzzle_id IS NULL). The puzzles table stays
        // CLI-only — uploads are how *players* bring a one-off file to
        // play, not how the curated library grows.
        //
        // The multipart plugin throws on (a) non-multipart bodies and
        // (b) files over the configured fileSize cap. Both should be
        // reported as 400, not bubbled to a 500. The parser is in a
        // second try-block so a clean buffer-read failure can't be
        // mistaken for a malformed puzzle.
        let file: Awaited<ReturnType<typeof req.file>>;
        let buffer: Buffer;
        try {
          file = await req.file();
          if (!file) {
            return reply.code(400).send({ error: "missing file" });
          }
          buffer = await file.toBuffer();
        } catch (err) {
          req.log.warn({ err }, "upload: failed to read multipart body");
          const msg = err instanceof Error ? err.message : "invalid upload";
          return reply.code(400).send({ error: msg });
        }
        const id = randomUUID();
        const format = detectFormat(file.filename, buffer);
        try {
          const parsed = parsePuzzleBuffer(id, buffer, format);
          const ipuz = writeIpuz(parsed.state, parsed.solution);
          const meta = parsed.state.meta;
          insertBoardRow({
            db,
            boardId: id,
            puzzleId: null,
            ipuz,
            title: meta.title,
            author: meta.author,
            copyright: meta.copyright,
            snapshot: JSON.stringify(parsed.state.snapshot),
          });
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

      api.delete<{ Params: { id: string } }>("/boards/:id", async (req, reply) => {
        // Hard delete. Order matters: close ws sockets so they stop
        // mutating the entry, DELETE the row *before* evicting so any
        // racing WS connect that lazy-loads sees a missing row and
        // 1008-closes (rather than resurrecting the entry into the
        // cache between evict and delete), then evict the cache to
        // cancel its pending flush timer. The cache entry may briefly
        // outlive the row; its eventual flush UPDATE matches 0 rows
        // and silently no-ops.
        const id = req.params.id;
        const cached = getCachedBoard(id);
        if (cached) {
          for (const s of cached.sockets) {
            if (s.readyState === s.OPEN) s.close(1000, "board deleted");
          }
        }
        const { existed } = deleteBoard(db, id);
        evictBoard(id);
        if (!existed) return reply.code(404).send({ error: "not found" });
        return { ok: true };
      });

      api.get<{ Params: { id: string } }>("/boards/:id/ipuz", async (req, reply) => {
        // Download a board (the player's current state) as canonical ipuz.
        // Lazy-load via the in-memory cache so an active board reflects
        // any in-flight fills; an idle board falls through to the DB row.
        const entry = getOrLoadBoard(db, req.params.id);
        if (!entry) return reply.code(404).send({ error: "not found" });
        const json = writeIpuz(entry.state, entry.solution);
        // slugify guarantees a non-empty result (falls back to "puzzle"),
        // so no need for a further fallback on the meta id.
        const stem = slugify(entry.state.meta.title);
        reply
          .header("content-type", "application/json; charset=utf-8")
          .header("content-disposition", `attachment; filename="${stem}.ipuz"`);
        return json;
      });
    },
    { prefix: "/api" },
  );
}
