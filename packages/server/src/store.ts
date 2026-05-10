import type { WebSocket } from "ws";
import type { PuzzleState } from "@crossplay/shared";

export type StoredPuzzle = {
  state: PuzzleState;
  solution: (string | null)[][];
  sockets: Set<WebSocket>;
  // name -> last hello timestamp; used to debounce "Alice joined" on
  // reconnect blips (a hello within the window is not re-announced).
  recentHellos: Map<string, number>;
};

const puzzles = new Map<string, StoredPuzzle>();

export function putPuzzle(
  id: string,
  entry: Omit<StoredPuzzle, "sockets" | "recentHellos">,
): void {
  puzzles.set(id, { ...entry, sockets: new Set(), recentHellos: new Map() });
}

export function getPuzzle(id: string): StoredPuzzle | undefined {
  return puzzles.get(id);
}
