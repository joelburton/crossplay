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
import { findUserByHandle, validateHandle } from "./auth.js";
import { registerAuthRoutes } from "./authRoutes.js";
import { IpuzUnsupportedError, writeIpuz } from "./ipuz.js";
import { evictBoard, getCachedBoard, getOrLoadBoard } from "./store.js";
import { slugify } from "./importer.js";
import { detectFormat, parsePuzzleBuffer } from "./format.js";
import {
  PuzzleNotFoundError,
  addBoardMembership,
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
      // Auth routes (register / login / logout / me) under /api/auth.
      // The session middleware itself is registered globally in
      // index.ts so it runs on every request, not just /api/auth.
      await api.register(
        async (auth) => {
          registerAuthRoutes(auth, db);
        },
        { prefix: "/auth" },
      );

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
        // Upload requires a logged-in user under Posture A — uploads
        // are how account-holders bring a one-off file to play, not
        // an anon entry point. The session middleware has already
        // attached req.user; we just check it.
        if (!req.user) {
          return reply.code(401).send({ error: "not logged in" });
        }
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
          // Board + membership in one transaction — mirrors
          // findOrCreateBoard's invariant ("a board always has at
          // least its creator as a member").
          db.exec("BEGIN");
          try {
            insertBoardRow({
              db,
              boardId: id,
              puzzleId: null,
              ipuz,
              title: meta.title,
              author: meta.author,
              copyright: meta.copyright,
              snapshot: JSON.stringify(parsed.state.snapshot),
              ownerId: req.user.id,
            });
            addBoardMembership(db, id, req.user.id);
            db.exec("COMMIT");
          } catch (err) {
            db.exec("ROLLBACK");
            throw err;
          }
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
        // Per-user dedup: clicking a library puzzle either creates a
        // new board for me OR navigates to my existing one for that
        // puzzle. Requires auth — anons have no identity to scope by.
        if (!req.user) {
          return reply.code(401).send({ error: "not logged in" });
        }
        const puzzleId = req.body?.puzzleId;
        if (!puzzleId || typeof puzzleId !== "string") {
          return reply.code(400).send({ error: "missing puzzleId" });
        }
        try {
          const { boardId } = findOrCreateBoard(db, puzzleId, req.user.id);
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

      api.get("/boards", async (req, reply) => {
        // "My games": boards this user owns (Phase 2 interim — Phase 3
        // switches to a `boards_users` membership query so shared
        // boards also show up).
        if (!req.user) {
          return reply.code(401).send({ error: "not logged in" });
        }
        return listBoards(db, req.user.id);
      });

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

      api.post<{ Params: { id: string }; Body: { handle?: unknown } }>(
        "/boards/:id/share",
        async (req, reply) => {
          // Add a user to this board's `boards_users`. Sharing is
          // idempotent: re-sharing with an existing member returns
          // 200 with alreadyMember=true (the UI can soften the
          // confirmation copy). Sharing with yourself is the same —
          // you're already a member.
          //
          // Authorization rule: the caller must already be a member.
          // Otherwise any anon URL-follower could pull strangers into
          // their friend's board, which defeats the invite-code gate
          // at the registration boundary.
          if (!req.user) {
            return reply.code(401).send({ error: "not logged in" });
          }
          const board = db
            .prepare("SELECT id FROM boards WHERE id = ?")
            .get(req.params.id) as { id: string } | undefined;
          if (!board) return reply.code(404).send({ error: "not found" });
          const callerMember = db
            .prepare(
              "SELECT 1 AS ok FROM boards_users WHERE board_id = ? AND user_id = ?",
            )
            .get(req.params.id, req.user.id) as { ok: number } | undefined;
          if (!callerMember) {
            return reply
              .code(403)
              .send({ error: "you aren't a member of this board" });
          }
          const handleInput = typeof req.body?.handle === "string" ? req.body.handle : "";
          const handleLower = validateHandle(handleInput);
          if (!handleLower) {
            return reply
              .code(400)
              .send({ error: "Handle must be 2–32 characters: letters, digits, _ or -." });
          }
          const target = findUserByHandle(db, handleLower);
          if (!target) {
            return reply.code(404).send({ error: "No user with that handle." });
          }
          const newlyAdded = addBoardMembership(db, req.params.id, target.id);
          return { handle: target.handle, alreadyMember: !newlyAdded };
        },
      );

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
