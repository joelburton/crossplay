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

import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { FastifyInstance } from "fastify";
import { findUserByHandle, validateHandle } from "./auth.js";
import { registerAuthRoutes } from "./authRoutes.js";
import { IpuzUnsupportedError, writeIpuz } from "./ipuz.js";
import { evictBoard, getCachedBoard, getOrLoadBoard, isBoardLive } from "./store.js";
import { slugify } from "./importer.js";
import { detectFormat, parsePuzzleBuffer } from "./format.js";
import {
  NytAuthError,
  NytFetchError,
  NytNoPuzzleError,
  fetchNytPuzzleForDate,
  parseStoredCookieJar,
} from "./nyt.js";
import {
  PuzzleNotFoundError,
  addBoardMembership,
  findOrCreateBoard,
  getBoardState,
  insertBoardRow,
  listBoards,
} from "./boards.js";
import { resolveClueForExplain, sliceNoteForClue } from "./clueAnswer.js";
import { explainClue, isAnthropicConfigured } from "./anthropic.js";

/** In-memory cache for the Explain feature. Key: SHA-256 of
 *  `clueText|answer|note`; value: cleaned explanation + scratchpad.
 *  Deterministic given (clue, answer, note), so once computed a
 *  re-open is instant. Lives only for the server process — no DB
 *  table, by design (see project plan). */
const explainCache = new Map<string, { explanation: string; scratchpad: string }>();

function explainCacheKey(clueText: string, answer: string, note: string): string {
  return createHash("sha256").update(`${clueText}|${answer}|${note}`).digest("hex");
}

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

      api.post<{ Body: { date?: unknown } }>("/boards/fetch-nyt", async (req, reply) => {
        // Fetch one daily NYT crossword on the user's behalf using their
        // stored cookie jar, convert to ipuz, and stamp a fresh board
        // (puzzle_id = NULL — same shape as the upload route). The
        // resulting board feeds the normal play flow.
        //
        // Failure modes map to status codes the UI can react to:
        //   - 401 not logged in
        //   - 400 no stored cookie / bad date format
        //   - 404 NYT has no Normal puzzle for that date
        //   - 502 cookie likely expired / network / unexpected NYT body
        if (!req.user) {
          return reply.code(401).send({ error: "not logged in" });
        }
        const date = typeof req.body?.date === "string" ? req.body.date.trim() : "";
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
          return reply.code(400).send({ error: "date must be yyyy-mm-dd" });
        }
        let jar;
        try {
          jar = parseStoredCookieJar(req.user.nyt_cookie);
        } catch (err) {
          req.log.warn({ err }, "fetch-nyt: malformed stored cookie jar");
          return reply
            .code(400)
            .send({ error: "Your stored NYT cookie is malformed. Refresh it." });
        }
        if (!jar) {
          return reply
            .code(400)
            .send({ error: "No NYT cookie on file. Save one before fetching." });
        }

        let fetched;
        try {
          fetched = await fetchNytPuzzleForDate(jar, date);
        } catch (err) {
          if (err instanceof NytNoPuzzleError) {
            return reply.code(404).send({ error: err.message });
          }
          if (err instanceof NytAuthError) {
            return reply.code(502).send({ error: err.message });
          }
          if (err instanceof NytFetchError) {
            req.log.warn({ err }, "fetch-nyt: upstream error");
            return reply.code(502).send({ error: err.message });
          }
          throw err;
        }

        const id = randomUUID();
        try {
          // Re-stamp the puzzle's id so the saved ipuz is keyed by our
          // board uuid, not the NYT print-date string the converter
          // defaults to. Matches what the upload route does.
          const state = {
            ...fetched.state,
            meta: { ...fetched.state.meta, id },
          };
          const ipuz = writeIpuz(state, fetched.solution);
          const meta = state.meta;
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
              snapshot: JSON.stringify(state.snapshot),
              ownerId: req.user.id,
            });
            addBoardMembership(db, id, req.user.id);
            db.exec("COMMIT");
          } catch (err) {
            db.exec("ROLLBACK");
            throw err;
          }
          return { boardId: id };
        } catch (err) {
          req.log.error({ err }, "fetch-nyt: failed to write board");
          if (err instanceof IpuzUnsupportedError) {
            return reply.code(400).send({ error: err.message });
          }
          throw err;
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
        // "My games": every board the caller is a member of (whether
        // they created it or someone shared it with them). Each row
        // also carries `isLive`, derived from the in-memory store —
        // surfaces "someone is playing this right now" so a peer can
        // jump in without an out-of-band ping.
        if (!req.user) {
          return reply.code(401).send({ error: "not logged in" });
        }
        const boards = listBoards(db, req.user.id);
        return boards.map((b) => ({ ...b, isLive: isBoardLive(b.id) }));
      });

      api.get<{ Params: { id: string } }>("/boards/:id", async (req, reply) => {
        const state = getBoardState(db, req.params.id);
        if (!state) return reply.code(404).send({ error: "not found" });
        return state;
      });

      api.delete<{ Params: { id: string } }>("/boards/:id", async (req, reply) => {
        // Semantically "leave this board": remove the caller's
        // `boards_users` row. If that was the last membership, also
        // hard-delete the board (force-close ws sockets, evict the
        // cache). Returns `{ ok, deleted }` so the UI can react —
        // most callers just remove the row from My Games either way,
        // but `deleted: true` would let us surface "the last
        // collaborator left, so the board is gone" copy if we ever
        // want it.
        //
        // 404 covers both "no such board" and "board exists but you
        // aren't a member" — from the caller's perspective the row
        // wasn't in their list either way.
        if (!req.user) {
          return reply.code(401).send({ error: "not logged in" });
        }
        const id = req.params.id;
        const member = db
          .prepare("SELECT 1 AS ok FROM boards_users WHERE board_id = ? AND user_id = ?")
          .get(id, req.user.id) as { ok: number } | undefined;
        if (!member) return reply.code(404).send({ error: "not found" });

        // Single transaction: drop my membership row, count what's
        // left, hard-delete the board if I was the last one. Socket
        // close + cache evict happen after commit (they touch
        // process state, not the DB).
        let boardDeleted = false;
        db.exec("BEGIN");
        try {
          db.prepare("DELETE FROM boards_users WHERE board_id = ? AND user_id = ?").run(
            id,
            req.user.id,
          );
          const remaining = db
            .prepare("SELECT COUNT(*) AS c FROM boards_users WHERE board_id = ?")
            .get(id) as { c: number };
          if (remaining.c === 0) {
            db.prepare("DELETE FROM boards WHERE id = ?").run(id);
            boardDeleted = true;
          }
          db.exec("COMMIT");
        } catch (err) {
          db.exec("ROLLBACK");
          throw err;
        }

        if (boardDeleted) {
          // Same order as the previous (pre-membership) DELETE: close
          // sockets first so they stop mutating the cache entry, then
          // evict to cancel any pending flush timer. The DB row is
          // already gone, so a racing WS connect would see no row and
          // 1008-close.
          const cached = getCachedBoard(id);
          if (cached) {
            for (const s of cached.sockets) {
              if (s.readyState === s.OPEN) s.close(1000, "board deleted");
            }
          }
          evictBoard(id);
        }
        return { ok: true, deleted: boardDeleted };
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

      api.get<{ Params: { id: string } }>("/boards/:id/solution", async (req, reply) => {
        // Solution arrays for the print "answer key" PDF. Public —
        // same posture as the ipuz download (which also exposes the
        // solution). The play layer still goes through `GET /boards/:id`
        // which omits solution; this is an explicit print-targeted
        // surface so the client doesn't have to parse ipuz itself.
        const entry = getOrLoadBoard(db, req.params.id);
        if (!entry) return reply.code(404).send({ error: "not found" });
        return { solution: entry.solution };
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

      api.post<{
        Params: { id: string };
        Body: { number?: unknown; direction?: unknown };
      }>("/boards/:id/explain-clue", async (req, reply) => {
        // Explain a cryptic clue by asking Gemini to JUSTIFY the
        // known answer. Gated by the puzzle having a setter's note
        // (proxy for "cryptic") and by the clue being fully &
        // correctly filled — the latter checked server-side because
        // the solution is server-only. Anon callers are fine: same
        // public posture as the board play page (Posture A).
        if (!isAnthropicConfigured()) {
          return reply.code(503).send({ error: "explain not configured" });
        }
        const entry = getOrLoadBoard(db, req.params.id);
        if (!entry) return reply.code(404).send({ error: "not found" });
        const note = entry.state.meta.note ?? "";
        if (note.trim().length === 0) {
          return reply.code(400).send({ error: "no_note" });
        }
        const number = typeof req.body?.number === "number" ? req.body.number : NaN;
        const direction = req.body?.direction;
        if (
          !Number.isFinite(number) ||
          (direction !== "across" && direction !== "down")
        ) {
          return reply.code(400).send({ error: "bad_request" });
        }
        const resolved = resolveClueForExplain(entry, number, direction);
        if (!resolved.ok) {
          return reply.code(404).send({ error: resolved.reason });
        }
        const ctx = resolved.context;
        if (!ctx.allFilled) {
          return reply.code(409).send({ reason: "incomplete" });
        }
        if (!ctx.fillCorrect) {
          return reply.code(409).send({ reason: "wrong" });
        }

        // Slice the full setter's note down to just this clue's
        // entry — the full block lists every clue and would spoil
        // the rest of the puzzle in the popover. If slicing fails
        // (note doesn't match the ACROSS/DOWN format), we send no
        // note rather than the whole block.
        const clueNote = sliceNoteForClue(note, number, direction);

        const key = explainCacheKey(ctx.clueText, ctx.answer, clueNote);
        const cached = explainCache.get(key);
        if (cached) {
          return {
            explanation: cached.explanation,
            scratchpad: cached.scratchpad,
            note: clueNote,
          };
        }
        const result = await explainClue({
          clueText: ctx.clueText,
          answer: ctx.answer,
          enumeration: ctx.enumeration,
          note: clueNote,
        });
        if (!result.ok) {
          // Surface the detail in the server log AND in the response
          // body so misconfiguration (wrong model name, bad key, body
          // shape rejected) is debuggable from either terminal or
          // browser dev tools.
          req.log.error(
            { reason: result.reason, detail: result.detail },
            "anthropic explain-clue failed",
          );
          return reply
            .code(502)
            .send({ error: "llm_error", reason: result.reason, detail: result.detail });
        }
        explainCache.set(key, {
          explanation: result.explanation,
          scratchpad: result.scratchpad,
        });
        return {
          explanation: result.explanation,
          scratchpad: result.scratchpad,
          note: clueNote,
        };
      });
    },
    { prefix: "/api" },
  );
}
