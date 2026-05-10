/**
 * In‑memory puzzle store.
 *
 * Persistence is a non‑goal today: a server restart wipes uploaded
 * puzzles and chat history. Library puzzles (anything in `GAME_DIR`)
 * re‑load from disk on startup, so they survive restarts; uploads do
 * not.
 *
 * Each `StoredPuzzle` carries the state we serve to clients, the
 * solution (kept server‑side), the live set of connected sockets for
 * broadcast, and the `recentHellos` debounce map.
 */

import type { WebSocket } from "ws";
import type { PuzzleState } from "@crossplay/shared";

export type StoredPuzzle = {
  state: PuzzleState;
  solution: (string | null)[][];
  sockets: Set<WebSocket>;
  // name -> last hello timestamp; used to debounce "Alice joined" on
  // reconnect blips (a hello within the window is not re-announced).
  recentHellos: Map<string, number>;
  // Per-room counter feeding `feedback.id` (see ws.ts `nextFeedbackId`).
  feedbackCounter: number;
};

const puzzles = new Map<string, StoredPuzzle>();

/** Insert (or replace) a puzzle in the store. Initializes `sockets`,
 *  `recentHellos`, and `feedbackCounter`; callers only supply
 *  `state` + `solution`. */
export function putPuzzle(
  id: string,
  entry: Omit<StoredPuzzle, "sockets" | "recentHellos" | "feedbackCounter">,
): void {
  puzzles.set(id, {
    ...entry,
    sockets: new Set(),
    recentHellos: new Map(),
    feedbackCounter: 0,
  });
}

/** Look up a puzzle by id. Returns `undefined` if not found (REST and WS
 *  routes treat that as a 404 / close). */
export function getPuzzle(id: string): StoredPuzzle | undefined {
  return puzzles.get(id);
}
