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
};

/** Find-or-create the (single) board for a puzzle. With users, this
 *  will become per-(user, puzzle); for now it's global.
 *  Throws PuzzleNotFoundError if the puzzle row doesn't exist. */
export function findOrCreateBoard(
  db: DatabaseSync,
  puzzleId: string,
): { boardId: string; newlyCreated: boolean } {
  const puzzle = db
    .prepare("SELECT id, ipuz, title, author FROM puzzles WHERE id = ?")
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
  const now = new Date().toISOString();
  db.prepare(
    "INSERT INTO boards (id, puzzle_id, ipuz, title, author, snapshot, chat, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, '[]', ?, ?)",
  ).run(boardId, puzzle.id, puzzle.ipuz, puzzle.title, puzzle.author, snapshot, now, now);

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
  updatedAt: string;
};

export function listBoards(db: DatabaseSync): BoardSummary[] {
  const rows = db
    .prepare(
      "SELECT id, puzzle_id, title, author, updated_at FROM boards ORDER BY updated_at DESC",
    )
    .all() as Array<{
    id: string;
    puzzle_id: string | null;
    title: string;
    author: string;
    updated_at: string;
  }>;
  return rows.map((r) => ({
    id: r.id,
    puzzleId: r.puzzle_id,
    title: r.title,
    author: r.author,
    updatedAt: r.updated_at,
  }));
}
