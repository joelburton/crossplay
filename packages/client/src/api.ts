/**
 * Thin REST client for the Crossplay server.
 *
 * Every helper throws `HttpError` (with the response status preserved)
 * on a non‑2xx response, so callers can branch on status codes — App
 * uses this to redirect to home on a 404 from `fetchBoard`.
 */

import type { PuzzleState } from "@crossplay/shared";

/** Error thrown by the REST helpers. `status` mirrors the HTTP status so
 *  callers can distinguish e.g. 404 from 500. */
export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/** Compact entry returned by `GET /api/puzzles` for the home page list. */
export type PuzzleSummary = {
  id: string;
  title: string;
  author: string;
  width: number;
  height: number;
};

/** Fetch the library of imported puzzles. */
export async function fetchPuzzles(): Promise<PuzzleSummary[]> {
  const res = await fetch("/api/puzzles");
  if (!res.ok) throw new HttpError(res.status, `fetch puzzles failed: ${res.status}`);
  return res.json();
}

/** Upload a `.puz` / `.ipuz` file as a fresh board. The server creates
 *  a board with no associated puzzle row (puzzle_id is NULL) and
 *  returns its id; the caller navigates to /b/<id>. */
export async function uploadBoard(file: File): Promise<{ boardId: string }> {
  const fd = new FormData();
  fd.append("file", file);
  const res = await fetch("/api/boards/upload", { method: "POST", body: fd });
  if (!res.ok) {
    // The server returns {error: "..."} on rejected uploads (unsupported
    // format features, parse failures); surface it so the user knows why.
    let detail = `${res.status}`;
    try {
      const body = (await res.json()) as { error?: unknown };
      if (typeof body.error === "string" && body.error) detail = body.error;
    } catch {
      // body wasn't JSON; fall back to status
    }
    throw new HttpError(res.status, `upload failed: ${detail}`);
  }
  return res.json();
}

/** Find-or-create a board for the given puzzle id. The server enforces
 *  one board per puzzle (will become per-(user, puzzle) once users
 *  exist). Returns the board id either way. */
export async function createBoard(puzzleId: string): Promise<{ boardId: string }> {
  const res = await fetch("/api/boards", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ puzzleId }),
  });
  if (!res.ok) throw new HttpError(res.status, `create board failed: ${res.status}`);
  return res.json();
}

/** Fetch a board's playable state (meta + live snapshot, no solution).
 *  A 404 indicates an unknown board id; App redirects home in that case. */
export async function fetchBoard(id: string): Promise<PuzzleState> {
  const res = await fetch(`/api/boards/${id}`);
  if (!res.ok) throw new HttpError(res.status, `fetch failed: ${res.status}`);
  return res.json();
}

/** Compact entry returned by `GET /api/boards` for the home page list. */
export type BoardSummary = {
  id: string;
  puzzleId: string | null;
  title: string;
  author: string;
  updatedAt: string;
};

/** Fetch the in-progress boards (any user can resume any board). */
export async function fetchBoards(): Promise<BoardSummary[]> {
  const res = await fetch("/api/boards");
  if (!res.ok) throw new HttpError(res.status, `fetch boards failed: ${res.status}`);
  return res.json();
}
