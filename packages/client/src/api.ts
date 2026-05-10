/**
 * Thin REST client for the Crossplay server.
 *
 * Every helper throws `HttpError` (with the response status preserved)
 * on a non‑2xx response, so callers can branch on status codes — App
 * uses this to redirect to home on a 404 from `fetchPuzzle`.
 */

import type { PuzzleState } from "@crossplay/shared";

/** Error thrown by the REST helpers. `status` mirrors the HTTP status so
 *  callers can distinguish e.g. 404 from 500. */
export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/** Compact entry returned by `GET /api/games` for the home page library. */
export type GameSummary = {
  id: string;
  title: string;
  author: string;
  width: number;
  height: number;
};

/** Fetch the library of pre-loaded puzzles served from `GAME_DIR`. */
export async function fetchGames(): Promise<GameSummary[]> {
  const res = await fetch("/api/games");
  if (!res.ok) throw new HttpError(res.status, `fetch games failed: ${res.status}`);
  return res.json();
}

/** Upload a `.puz` file. The server returns the new id; the caller is
 *  expected to navigate to `/p/:id`. */
export async function uploadPuzzle(file: File): Promise<{ puzzleId: string }> {
  const fd = new FormData();
  fd.append("file", file);
  const res = await fetch("/api/puzzles", { method: "POST", body: fd });
  if (!res.ok) throw new HttpError(res.status, `upload failed: ${res.status}`);
  return res.json();
}

/** Fetch a puzzle's playable state (meta + empty snapshot, no solution).
 *  A 404 indicates an unknown puzzle id; App redirects home in that case. */
export async function fetchPuzzle(id: string): Promise<PuzzleState> {
  const res = await fetch(`/api/puzzles/${id}`);
  if (!res.ok) throw new HttpError(res.status, `fetch failed: ${res.status}`);
  return res.json();
}
