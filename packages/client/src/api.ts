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
  copyright: string;
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
  copyright: string;
  updatedAt: string;
  /** Null when the board has no player fills (rendered as "NEW");
   *  otherwise an integer 0–100. */
  fillPercent: number | null;
  /** Co-player handles — every other member of the board. Empty
   *  for solo boards. Display-cased; ordered case-insensitively
   *  by the server so the home-page row's "Playing with moth, sue"
   *  is stable across reloads. */
  members: string[];
  /** True when at least one ws socket is currently connected to the
   *  board (someone is playing right now). Computed at request time;
   *  no real-time updates — refresh the page to re-poll. */
  isLive: boolean;
};

/** Fetch the in-progress boards (any user can resume any board). */
export async function fetchBoards(): Promise<BoardSummary[]> {
  const res = await fetch("/api/boards");
  if (!res.ok) throw new HttpError(res.status, `fetch boards failed: ${res.status}`);
  return res.json();
}

/** "Leave this board": removes the caller's membership. If they were
 *  the last member, the server hard-deletes the board (force-closes
 *  any active ws sockets first). Returns `{ deleted }` so the caller
 *  can soften copy when the last collaborator left. */
export async function deleteBoard(id: string): Promise<{ deleted: boolean }> {
  const res = await fetch(`/api/boards/${id}`, { method: "DELETE" });
  if (!res.ok) throw new HttpError(res.status, `delete failed: ${res.status}`);
  const body = (await res.json()) as { deleted?: boolean };
  return { deleted: Boolean(body.deleted) };
}

/** Add a member to a board by handle. Resolves the canonical
 *  display-cased handle from the server (so a "moth" input comes
 *  back "Moth"). `alreadyMember: true` covers both "they were
 *  already on it" and "you typed your own handle." */
export async function shareBoard(
  boardId: string,
  handle: string,
): Promise<{ handle: string; alreadyMember: boolean }> {
  const res = await fetch(`/api/boards/${boardId}/share`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ handle }),
  });
  if (!res.ok) throw new HttpError(res.status, await readErrorMessage(res));
  return (await res.json()) as { handle: string; alreadyMember: boolean };
}

// -----------------------------------------------------------------
// Auth (Phase 1)
//
// The server sets an HTTP-only session cookie on register / login,
// clears it on logout. The cookie rides natively on every fetch
// (same-origin requests include cookies by default), so callers
// don't have to manage tokens.
// -----------------------------------------------------------------

/** Public-facing user shape. Mirrors `PublicUser` on the server —
 *  never includes the password hash. */
export type AuthUser = {
  id: number;
  handle: string;
  email: string | null;
  isAdmin: boolean;
  createdAt: string;
};

/** Lift the server's `{error: "..."}` field into an HttpError message
 *  when present; falls back to a generic status-derived string. Used
 *  by all auth endpoints because their failure modes are user-facing. */
async function readErrorMessage(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: unknown };
    if (typeof body.error === "string" && body.error) return body.error;
  } catch {
    // not JSON; fall through
  }
  return `${res.status}`;
}

/** Probe whether the current browser is logged in. Returns the user
 *  on success, null on 401, throws on any other error. Used by App
 *  at mount to decide which top-level surface to render. */
export async function fetchMe(): Promise<AuthUser | null> {
  const res = await fetch("/api/auth/me");
  if (res.status === 401) return null;
  if (!res.ok) throw new HttpError(res.status, await readErrorMessage(res));
  const body = (await res.json()) as { user: AuthUser };
  return body.user;
}

/** Create an account. The server sets the session cookie on success;
 *  the returned user is what `fetchMe` would have returned. */
export async function register(args: {
  handle: string;
  password: string;
  inviteCode: string;
}): Promise<AuthUser> {
  const res = await fetch("/api/auth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(args),
  });
  if (!res.ok) throw new HttpError(res.status, await readErrorMessage(res));
  return ((await res.json()) as { user: AuthUser }).user;
}

/** Log in. Sets the session cookie on success. */
export async function login(args: {
  handle: string;
  password: string;
}): Promise<AuthUser> {
  const res = await fetch("/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(args),
  });
  if (!res.ok) throw new HttpError(res.status, await readErrorMessage(res));
  return ((await res.json()) as { user: AuthUser }).user;
}

/** Log out. Clears the session cookie + row. Idempotent server-side
 *  (a stale cookie won't 4xx), so we never reject here. */
export async function logout(): Promise<void> {
  const res = await fetch("/api/auth/logout", { method: "POST" });
  if (!res.ok) throw new HttpError(res.status, await readErrorMessage(res));
}
