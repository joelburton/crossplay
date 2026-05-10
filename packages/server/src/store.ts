import type { WebSocket } from "ws";
import type { PuzzleState } from "@crossplay/shared";

export type StoredPuzzle = {
  state: PuzzleState;
  solution: (string | null)[][];
  sockets: Set<WebSocket>;
};

const puzzles = new Map<string, StoredPuzzle>();

export function putPuzzle(
  id: string,
  entry: Omit<StoredPuzzle, "sockets">,
): void {
  puzzles.set(id, { ...entry, sockets: new Set() });
}

export function getPuzzle(id: string): StoredPuzzle | undefined {
  return puzzles.get(id);
}
