/**
 * Board operations against the sqlite store. These are pure DB
 * operations — no in-memory store side effects — so they're easy to
 * test and the route handlers can decide what to mirror into the
 * temporary in-memory cache.
 *
 * Two main entry points:
 *   - findOrCreateBoard: enforces "one board per puzzle" in our
 *     pre-user world; later when users exist this becomes "per
 *     (user, puzzle)".
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
 *  call sites can't drift. Chat starts empty. */
export function insertBoardRow(args: {
  db: DatabaseSync;
  boardId: string;
  puzzleId: string | null;
  ipuz: string;
  title: string;
  author: string;
  copyright: string;
  snapshot: string;
}): void {
  const now = new Date().toISOString();
  args.db
    .prepare(
      "INSERT INTO boards (id, puzzle_id, ipuz, title, author, copyright, snapshot, chat, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, '[]', ?, ?)",
    )
    .run(
      args.boardId,
      args.puzzleId,
      args.ipuz,
      args.title,
      args.author,
      args.copyright,
      args.snapshot,
      now,
      now,
    );
}

/** Find-or-create the (single) global board for a library puzzle.
 *  With users, this will become per-(user, puzzle); for now it's
 *  global. Ad-hoc upload boards (puzzle_id IS NULL) are intentionally
 *  invisible to this lookup — they're separate playthroughs created
 *  by `POST /api/boards/upload`, not surfaced under any puzzle id.
 *  Throws PuzzleNotFoundError if the puzzle row doesn't exist. */
export function findOrCreateBoard(
  db: DatabaseSync,
  puzzleId: string,
): { boardId: string; newlyCreated: boolean } {
  const puzzle = db
    .prepare("SELECT id, ipuz, title, author, copyright FROM puzzles WHERE id = ?")
    .get(puzzleId) as PuzzleRow | undefined;
  if (!puzzle) throw new PuzzleNotFoundError(puzzleId);

  const existing = db
    .prepare("SELECT id FROM boards WHERE puzzle_id = ? LIMIT 1")
    .get(puzzleId) as { id: string } | undefined;
  if (existing) return { boardId: existing.id, newlyCreated: false };

  const boardId = randomUUID();
  // Parse the puzzle's ipuz to get the initial GridSnapshot. Copy the
  // ipuz string verbatim into boards.ipuz — it's already canonical.
  const parsed = parseIpuzBuffer(boardId, Buffer.from(puzzle.ipuz, "utf8"));
  const snapshot = JSON.stringify(parsed.state.snapshot);
  insertBoardRow({
    db,
    boardId,
    puzzleId: puzzle.id,
    ipuz: puzzle.ipuz,
    title: puzzle.title,
    author: puzzle.author,
    copyright: puzzle.copyright,
    snapshot,
  });

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

export function listBoards(db: DatabaseSync): BoardSummary[] {
  const rows = db
    .prepare(
      "SELECT id, puzzle_id, title, author, copyright, updated_at, fill_percent FROM boards ORDER BY updated_at DESC",
    )
    .all() as Array<{
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
