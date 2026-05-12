/**
 * Board operations against the sqlite store. These are pure DB
 * operations — no in-memory store side effects — so they're easy to
 * test and the route handlers can decide what to mirror into the
 * temporary in-memory cache.
 *
 * Two main entry points:
 *   - findOrCreateBoard: enforces "one board per (user, library
 *     puzzle)" — looks up via the `boards_users` join (so a board
 *     someone shared with me also dedups my library-click), and on
 *     creation auto-inserts the owner into the membership table.
 *   - getBoardState: hydrates a board into the same PuzzleState shape
 *     the play layer expects (meta from the immutable ipuz blob;
 *     snapshot from the live boards.snapshot column). Solution stays
 *     server-side — we never expose it on this route.
 */

import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { PuzzleState } from "@crossplay/shared";
import { parseIpuzBuffer } from "./ipuz.js";

export class PuzzleNotFoundError extends Error {
  constructor(public puzzleId: string) {
    super(`puzzle '${puzzleId}' not found`);
  }
}

type PuzzleRow = {
  id: string;
  ipuz: string;
  title: string;
  author: string;
  copyright: string;
};

/** Shared INSERT for the `boards` table. Used by `findOrCreateBoard`
 *  (stamps from a library puzzle) and the upload route (ad-hoc, with
 *  `puzzleId: null`). One spelling of the column order so the two
 *  call sites can't drift. Chat starts empty.
 *
 *  `ownerId` is nullable on the column itself for migration / cascade
 *  reasons, but every fresh board under Posture A carries one — the
 *  route layer is responsible for refusing creation without an
 *  authenticated user. */
export function insertBoardRow(args: {
  db: DatabaseSync;
  boardId: string;
  puzzleId: string | null;
  ipuz: string;
  title: string;
  author: string;
  copyright: string;
  snapshot: string;
  ownerId: number | null;
}): void {
  const now = new Date().toISOString();
  args.db
    .prepare(
      "INSERT INTO boards (id, puzzle_id, ipuz, title, author, copyright, snapshot, chat, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, '[]', ?, ?, ?)",
    )
    .run(
      args.boardId,
      args.puzzleId,
      args.ipuz,
      args.title,
      args.author,
      args.copyright,
      args.snapshot,
      args.ownerId,
      now,
      now,
    );
}

/** Insert a membership row, idempotently. Returns true if a new row
 *  was actually added (false if the user was already a member). The
 *  composite PK on (board_id, user_id) makes INSERT OR IGNORE the
 *  natural shape: re-sharing with an existing member silently no-ops
 *  rather than raising. */
export function addBoardMembership(
  db: DatabaseSync,
  boardId: string,
  userId: number,
): boolean {
  const result = db
    .prepare(
      "INSERT OR IGNORE INTO boards_users (board_id, user_id, created_at) VALUES (?, ?, ?)",
    )
    .run(boardId, userId, new Date().toISOString());
  return result.changes > 0;
}

/** Find-or-create a board for `(puzzleId, userId)`. The dedup is
 *  membership-based: if the user is a member of any board for this
 *  puzzle (whether they created it or someone shared it with them),
 *  that's what we return. On creation, the owner is auto-inserted
 *  into `boards_users`. Ad-hoc upload boards (`puzzleId IS NULL`) are
 *  intentionally invisible to this lookup — they're separate
 *  playthroughs created by `POST /api/boards/upload`.
 *  Throws PuzzleNotFoundError if the puzzle row doesn't exist. */
export function findOrCreateBoard(
  db: DatabaseSync,
  puzzleId: string,
  ownerId: number,
): { boardId: string; newlyCreated: boolean } {
  const puzzle = db
    .prepare("SELECT id, ipuz, title, author, copyright FROM puzzles WHERE id = ?")
    .get(puzzleId) as PuzzleRow | undefined;
  if (!puzzle) throw new PuzzleNotFoundError(puzzleId);

  const existing = db
    .prepare(
      `SELECT b.id AS id
         FROM boards b
         JOIN boards_users bu ON bu.board_id = b.id
        WHERE b.puzzle_id = ? AND bu.user_id = ?
        LIMIT 1`,
    )
    .get(puzzleId, ownerId) as { id: string } | undefined;
  if (existing) return { boardId: existing.id, newlyCreated: false };

  const boardId = randomUUID();
  // Parse the puzzle's ipuz to get the initial GridSnapshot. Copy the
  // ipuz string verbatim into boards.ipuz — it's already canonical.
  const parsed = parseIpuzBuffer(boardId, Buffer.from(puzzle.ipuz, "utf8"));
  const snapshot = JSON.stringify(parsed.state.snapshot);
  // Board insert + membership insert are a single logical creation;
  // wrap so a crash between them can't leave a board with no members
  // (which would then look invisible to everyone).
  db.exec("BEGIN");
  try {
    insertBoardRow({
      db,
      boardId,
      puzzleId: puzzle.id,
      ipuz: puzzle.ipuz,
      title: puzzle.title,
      author: puzzle.author,
      copyright: puzzle.copyright,
      snapshot,
      ownerId,
    });
    addBoardMembership(db, boardId, ownerId);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }

  return { boardId, newlyCreated: true };
}

/** Read a board and return the PuzzleState the play layer expects:
 *  meta from the immutable ipuz blob, snapshot from the live column,
 *  no solution. Returns null on unknown id. */
export function getBoardState(db: DatabaseSync, boardId: string): PuzzleState | null {
  const row = db
    .prepare("SELECT ipuz, snapshot FROM boards WHERE id = ?")
    .get(boardId) as { ipuz: string; snapshot: string } | undefined;
  if (!row) return null;
  const parsed = parseIpuzBuffer(boardId, Buffer.from(row.ipuz, "utf8"));
  const liveSnapshot = JSON.parse(row.snapshot) as PuzzleState["snapshot"];
  return { meta: parsed.state.meta, snapshot: liveSnapshot };
}

export type BoardSummary = {
  id: string;
  puzzleId: string | null;
  title: string;
  author: string;
  copyright: string;
  updatedAt: string;
  /** Null when the board is untouched (rendered as "NEW" on the home
   *  page); otherwise an integer 0–100. Kept up to date by `flushBoard`. */
  fillPercent: number | null;
};

/** Hard-delete a board row. Returns whether a row was removed so the
 *  caller can map "no such id" to 404. Cache eviction and socket
 *  cleanup are the caller's job (this is a pure DB op). */
export function deleteBoard(db: DatabaseSync, boardId: string): { existed: boolean } {
  const result = db.prepare("DELETE FROM boards WHERE id = ?").run(boardId);
  return { existed: result.changes > 0 };
}

/** List boards the user is a member of (Phase 3: query the
 *  `boards_users` join, so boards shared with the user show up
 *  alongside ones they created). Anon-era boards (no membership row
 *  for anyone) are invisible to every user's list — URL-accessible
 *  but undiscoverable. */
export function listBoards(db: DatabaseSync, userId: number): BoardSummary[] {
  const rows = db
    .prepare(
      `SELECT b.id           AS id,
              b.puzzle_id    AS puzzle_id,
              b.title        AS title,
              b.author       AS author,
              b.copyright    AS copyright,
              b.updated_at   AS updated_at,
              b.fill_percent AS fill_percent
         FROM boards b
         JOIN boards_users bu ON bu.board_id = b.id
        WHERE bu.user_id = ?
        ORDER BY b.updated_at DESC`,
    )
    .all(userId) as Array<{
    id: string;
    puzzle_id: string | null;
    title: string;
    author: string;
    copyright: string;
    updated_at: string;
    fill_percent: number | null;
  }>;
  return rows.map((r) => ({
    id: r.id,
    puzzleId: r.puzzle_id,
    title: r.title,
    author: r.author,
    copyright: r.copyright,
    updatedAt: r.updated_at,
    fillPercent: r.fill_percent,
  }));
}
