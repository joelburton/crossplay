/**
 * In-memory cache of *active* boards plus the flush scheduler that
 * writes dirty entries back to sqlite. Boards are lazily loaded on the
 * first WebSocket connect to their id, parsed from the row's ipuz blob
 * (template + solution + initial snapshot) and snapshot column (live
 * state).
 *
 * Mutations during play (fills, reveals, chat appends) set `dirty =
 * true` via `markDirty`, which also (re)starts a per-board 15s idle
 * timer. When the timer fires, `flushBoard` writes `snapshot` + `chat`
 * + `updated_at` back to the DB and clears the dirty flag. Activity
 * within the 15s window resets the timer — so a steady solver writes
 * back roughly every 15s of pause, not per keystroke.
 *
 * On last-socket-disconnect, the ws layer calls `flushAndEvict` to
 * persist + drop the entry from the cache. On SIGTERM/SIGINT, index.ts
 * calls `flushAll` to drain every dirty entry before closing the DB.
 *
 * Trade-off: a hard crash inside the 15s window loses up to 15s of
 * play. That's by design — see `project_sqlite_sprint_plan.md`.
 */

import type { WebSocket } from "ws";
import type { DatabaseSync } from "node:sqlite";
import type { GridSnapshot, PuzzleState } from "@crossplay/shared";
import { parseIpuzBuffer } from "./ipuz.js";
import { computeFillPercent } from "./fillPercent.js";

/** A single chat message, persisted in `boards.chat` as a JSON array.
 *  Same shape as the `chatMessage` ServerMessage and the client's
 *  ChatLine — kept in sync by hand. */
export type ChatLine = {
  name: string;
  color: string;
  text: string;
  ts: number;
};

export type StoredBoard = {
  id: string;
  state: PuzzleState;
  /** The board's snapshot at creation time. `applyClear` restores to
   *  this so author-prefilled cells survive the wipe. */
  initialSnapshot: GridSnapshot;
  /** Server-only: never sent on the wire. Used by reveal/check. */
  solution: (string | null)[][];
  /** Persisted chat history (will be flushed back to `boards.chat`). */
  chat: ChatLine[];
  sockets: Set<WebSocket>;
  // name -> last hello timestamp; used to debounce "Alice joined" on
  // reconnect blips (a hello within the window is not re-announced).
  recentHellos: Map<string, number>;
  // Per-room counter feeding `feedback.id` (see ws.ts `nextFeedbackId`).
  feedbackCounter: number;
  /** True when the entry has unsaved snapshot/chat mutations. The flush
   *  scheduler reads and clears this. */
  dirty: boolean;
};

const cache = new Map<string, StoredBoard>();

/** Lazy-load a board from the DB into the cache and return the cached
 *  entry. Returns undefined if no row with that id exists. The first
 *  ws connect to a board hits the DB; later connects find it cached. */
export function getOrLoadBoard(db: DatabaseSync, boardId: string): StoredBoard | undefined {
  const existing = cache.get(boardId);
  if (existing) return existing;

  const row = db
    .prepare("SELECT ipuz, snapshot, chat FROM boards WHERE id = ?")
    .get(boardId) as { ipuz: string; snapshot: string; chat: string } | undefined;
  if (!row) return undefined;

  const parsed = parseIpuzBuffer(boardId, Buffer.from(row.ipuz, "utf8"));
  const liveSnapshot = JSON.parse(row.snapshot) as GridSnapshot;
  const chat = JSON.parse(row.chat) as ChatLine[];

  const entry: StoredBoard = {
    id: boardId,
    state: { meta: parsed.state.meta, snapshot: liveSnapshot },
    initialSnapshot: parsed.state.snapshot,
    solution: parsed.solution,
    chat,
    sockets: new Set(),
    recentHellos: new Map(),
    feedbackCounter: 0,
    dirty: false,
  };
  cache.set(boardId, entry);
  return entry;
}

/** Idle window before a dirty entry is written back. Exported so tests
 *  can read the same value when advancing fake timers. */
export const FLUSH_IDLE_MS = 15_000;

const flushTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** Mark a cached entry as dirty AND (re)schedule its 15s flush timer.
 *  Called from the apply* mutators in ws.ts after a successful change.
 *  No-op if the entry isn't cached (the mutation happened against a
 *  stale reference — shouldn't occur under correct ws lifecycle). */
export function markDirty(db: DatabaseSync, boardId: string): void {
  const entry = cache.get(boardId);
  if (!entry) return;
  entry.dirty = true;
  const existing = flushTimers.get(boardId);
  if (existing) clearTimeout(existing);
  // Allow the timer to be unref'd so a sleeping debounced flush
  // doesn't keep the process alive past natural shutdown points.
  const t = setTimeout(() => flushBoard(db, boardId), FLUSH_IDLE_MS);
  if (typeof t.unref === "function") t.unref();
  flushTimers.set(boardId, t);
}

/** Cancel any pending idle timer for `boardId`. Used by flushBoard +
 *  evictBoard to keep state clean. */
function cancelFlushTimer(boardId: string): void {
  const t = flushTimers.get(boardId);
  if (t) {
    clearTimeout(t);
    flushTimers.delete(boardId);
  }
}

/** Persist the cached board's snapshot + chat back to the DB if dirty,
 *  then clear the flag and any pending idle timer. Idempotent: a clean
 *  entry is a no-op, so the timer-fire path and the explicit-flush
 *  path can both call this safely. */
export function flushBoard(db: DatabaseSync, boardId: string): void {
  cancelFlushTimer(boardId);
  const entry = cache.get(boardId);
  if (!entry || !entry.dirty) return;
  const now = new Date().toISOString();
  const fillPercent = computeFillPercent(entry.initialSnapshot, entry.state.snapshot);
  db.prepare(
    "UPDATE boards SET snapshot = ?, chat = ?, updated_at = ?, fill_percent = ? WHERE id = ?",
  ).run(
    JSON.stringify(entry.state.snapshot),
    JSON.stringify(entry.chat),
    now,
    fillPercent,
    boardId,
  );
  entry.dirty = false;
}

/** Drop the cached entry. Cancels any pending flush timer; callers are
 *  expected to flush first (or use `flushAndEvict`) if they care about
 *  persistence — `evictBoard` alone will discard unsaved work. */
export function evictBoard(boardId: string): void {
  cancelFlushTimer(boardId);
  cache.delete(boardId);
}

/** Persist + drop. The ws layer calls this on last-socket-disconnect:
 *  no one is playing this board right now, so save and free the slot. */
export function flushAndEvict(db: DatabaseSync, boardId: string): void {
  flushBoard(db, boardId);
  evictBoard(boardId);
}

/** Drain every dirty cached entry. Called from the SIGTERM/SIGINT
 *  handler. Synchronous; safe to invoke right before `process.exit`. */
export function flushAll(db: DatabaseSync): void {
  for (const entry of cache.values()) {
    flushBoard(db, entry.id);
  }
}

/** Iterate every cached board. */
export function cachedBoards(): IterableIterator<StoredBoard> {
  return cache.values();
}

/** Peek at the cached entry for a board without lazy-loading from the
 *  DB. Used by the delete route to find sockets to close — we don't
 *  want to *load* a board just to delete it. */
export function getCachedBoard(boardId: string): StoredBoard | undefined {
  return cache.get(boardId);
}

/** Test-only: install a synthetic StoredBoard directly. Lets unit
 *  tests bypass the DB load path. Pair with `_clearCacheForTest`
 *  between tests. */
export function _putBoardForTest(entry: StoredBoard): void {
  cache.set(entry.id, entry);
}

/** Test-only: empty the cache and cancel any pending flush timers
 *  (call between tests). */
export function _clearCacheForTest(): void {
  for (const id of flushTimers.keys()) cancelFlushTimer(id);
  cache.clear();
}
