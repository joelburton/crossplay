/**
 * Authentication primitives: password hashing, session creation /
 * lookup / sliding-expiry maintenance.
 *
 * Password hashing uses Node's built-in `crypto.scryptSync` — no
 * native dependency. The stored format is a single self-describing
 * string so future parameter bumps (e.g. raising N) can coexist with
 * old hashes:
 *
 *   scrypt$<N>$<r>$<p>$<salt-hex>$<key-hex>
 *
 * Sessions are server-side rows keyed by a random 32-byte hex token.
 * The token is the cookie value the browser sends back; the row
 * carries user_id, sliding expiry (last_seen_at + SESSION_TTL_MS),
 * and creation time. Logout deletes the row; "log out everywhere"
 * (future) deletes all rows for a user.
 *
 * Handle validation: lowercase letters / digits / underscore /
 * hyphen, 2–32 characters. Lookups are case-insensitive against the
 * `handle_lower` column.
 */

import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

/** Sliding session window. Each authed request bumps last_seen_at
 *  and pushes expires_at forward by this much. 30 days is the right
 *  default for a casual friends-only site — long enough not to be
 *  annoying, short enough that a forgotten-shared laptop doesn't
 *  stay logged in forever. */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Minimum password length. We don't pester about composition (no
 *  required digits / symbols) — just enough that "a" isn't a
 *  password. Per the design doc. */
export const MIN_PASSWORD_LENGTH = 6;

/** Handle validation regex. Lowercase + digits + _ - only, length
 *  2–32. Tested against the lowercased form. */
export const HANDLE_RE = /^[a-z0-9_-]{2,32}$/;

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 32;
const SCRYPT_SALTLEN = 16;

/** Hash a password using scrypt with the constants above. Returns
 *  the self-describing storage string. Salt is fresh per call. */
export function hashPassword(password: string): string {
  const salt = randomBytes(SCRYPT_SALTLEN);
  const key = scryptSync(password, salt, SCRYPT_KEYLEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString("hex")}$${key.toString("hex")}`;
}

/** Verify a password against a stored hash string. Returns false on
 *  any parsing failure (treat malformed hashes as "doesn't match"
 *  rather than crashing the request). Uses constant-time comparison
 *  on the derived key. */
export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isFinite(N) || !Number.isFinite(r) || !Number.isFinite(p)) return false;
  let salt: Buffer;
  let storedKey: Buffer;
  try {
    salt = Buffer.from(parts[4]!, "hex");
    storedKey = Buffer.from(parts[5]!, "hex");
  } catch {
    return false;
  }
  if (storedKey.length === 0) return false;
  const derived = scryptSync(password, salt, storedKey.length, { N, r, p });
  return derived.length === storedKey.length && timingSafeEqual(derived, storedKey);
}

/** Normalize a handle for lookup / storage in `handle_lower`. */
export function normalizeHandle(handle: string): string {
  return handle.toLowerCase();
}

/** Validate a handle. Returns the normalized (lowercased) form, or
 *  null if the input is malformed. The caller is responsible for the
 *  case-preserved display form — pass the original alongside the
 *  normalized one when inserting. */
export function validateHandle(handle: string): string | null {
  if (typeof handle !== "string") return null;
  const trimmed = handle.trim();
  if (!trimmed) return null;
  const lower = trimmed.toLowerCase();
  if (!HANDLE_RE.test(lower)) return null;
  return lower;
}

/** Random opaque session token. 32 bytes of randomness, hex-encoded
 *  (64 chars). Fits comfortably in a cookie, indistinguishable from
 *  noise. */
export function newSessionToken(): string {
  return randomBytes(32).toString("hex");
}

export type SessionRow = {
  id: string;
  user_id: number;
  created_at: string;
  last_seen_at: string;
  expires_at: string;
};

export type UserRow = {
  id: number;
  handle: string;
  handle_lower: string;
  password_hash: string;
  email: string | null;
  is_admin: number;
  invite_code_used: string | null;
  prefs: string | null;
  seen_help_at: string | null;
  /** Stored JSON cookie jar (`{name: value}`) for the "Get from NYT"
   *  feature. NULL when the user hasn't pasted one in — the home page
   *  hides the form in that case. Never sent to the client. */
  nyt_cookie: string | null;
  created_at: string;
};

/** User preferences shape. All fields optional on the wire; missing
 *  keys fall back to `DEFAULT_PREFS`. The store column is JSON-encoded
 *  for ergonomics — preferences evolve fast, adding one shouldn't
 *  require a migration, and access pattern is always "load all prefs
 *  for one user" which JSON handles cleanly. See
 *  `docs/user-preferences-backlog.md` for the column-vs-JSON rationale. */
export interface Prefs {
  /** Override the deterministic name-hash color used in chat / cursor
   *  presence / sender flash. Stored as `#rrggbb` lowercase hex. When
   *  unset, the client falls back to `colorForName(handle)` — the
   *  existing eight-color hash mapping. */
  color?: string;
}

/** Defaults merged into whatever's stored. Adding a new pref means:
 *  add a key here, add a key to `Prefs`, ship. No migration. */
export const DEFAULT_PREFS: Prefs = {};

/** Validate a user-supplied color string. Accepts `#rrggbb` only (no
 *  shorthand, no named colors) — keeps the rendering predictable and
 *  storage-uniform. Returns the lowercased canonical form, or null on
 *  any malformed input. */
export function validateColor(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (!/^#[0-9a-fA-F]{6}$/.test(value)) return null;
  return value.toLowerCase();
}

/** Read + merge a user's preferences with the defaults. Always
 *  returns a fully-populated object — callers don't need to handle
 *  missing keys. Invalid stored JSON is treated as "no prefs set." */
export function getUserPrefs(db: DatabaseSync, userId: number): Prefs {
  const row = db.prepare("SELECT prefs FROM users WHERE id = ?").get(userId) as
    | { prefs: string | null }
    | undefined;
  if (!row?.prefs) return { ...DEFAULT_PREFS };
  try {
    const parsed = JSON.parse(row.prefs) as Partial<Prefs>;
    if (parsed && typeof parsed === "object") {
      return { ...DEFAULT_PREFS, ...parsed };
    }
  } catch {
    // fall through to defaults
  }
  return { ...DEFAULT_PREFS };
}

/** Patch a user's preferences. Reads current, merges, validates,
 *  writes. Partial — keys not in `partial` retain their stored value
 *  (or default if unset). Callers should validate at the route layer
 *  before passing in. */
export function setUserPrefs(
  db: DatabaseSync,
  userId: number,
  partial: Partial<Prefs>,
): void {
  const current = getUserPrefs(db, userId);
  const next = { ...current, ...partial };
  db.prepare("UPDATE users SET prefs = ? WHERE id = ?").run(JSON.stringify(next), userId);
}

/** Mark a user as having seen the help dialog. Called from the
 *  client when the auto-shown help is dismissed for the first time. */
export function markHelpSeen(db: DatabaseSync, userId: number): void {
  db.prepare("UPDATE users SET seen_help_at = ? WHERE id = ?").run(
    new Date().toISOString(),
    userId,
  );
}

/** Look up an invite code (case-insensitive). Returns true if it
 *  exists. Admins delete rows from the table to invalidate codes. */
export function inviteCodeExists(db: DatabaseSync, code: string): boolean {
  const row = db
    .prepare("SELECT 1 AS ok FROM invite_codes WHERE code = ?")
    .get(code.toLowerCase()) as { ok: number } | undefined;
  return row !== undefined;
}

/** Find a user by their (normalized) handle. */
export function findUserByHandle(db: DatabaseSync, handleLower: string): UserRow | undefined {
  return db
    .prepare("SELECT * FROM users WHERE handle_lower = ?")
    .get(handleLower) as UserRow | undefined;
}

/** Find a user by id (for session resolution). */
export function findUserById(db: DatabaseSync, id: number): UserRow | undefined {
  return db.prepare("SELECT * FROM users WHERE id = ?").get(id) as UserRow | undefined;
}

/** Insert a new user. Returns the new user's id. The caller is
 *  responsible for having validated handle + password + invite code
 *  beforehand. `handle` is the display (case-preserved) form;
 *  `handleLower` is the lookup form. */
export function createUser(
  db: DatabaseSync,
  args: {
    handle: string;
    handleLower: string;
    passwordHash: string;
    inviteCodeUsed: string | null;
    email?: string | null;
  },
): number {
  const now = new Date().toISOString();
  const result = db
    .prepare(
      "INSERT INTO users (handle, handle_lower, password_hash, email, invite_code_used, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run(
      args.handle,
      args.handleLower,
      args.passwordHash,
      args.email ?? null,
      args.inviteCodeUsed,
      now,
    );
  return Number(result.lastInsertRowid);
}

/** Create a session row for a user and return its token. The token
 *  goes into the response cookie; the row is the source of truth. */
export function createSession(db: DatabaseSync, userId: number): string {
  const id = newSessionToken();
  const now = Date.now();
  const created = new Date(now).toISOString();
  const expires = new Date(now + SESSION_TTL_MS).toISOString();
  db.prepare(
    "INSERT INTO sessions (id, user_id, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, ?, ?)",
  ).run(id, userId, created, created, expires);
  return id;
}

/** Look up a session by its token. Returns the row or undefined.
 *  Does NOT touch expiry — callers should call `touchSession` after
 *  a successful authed request. */
export function findSession(db: DatabaseSync, token: string): SessionRow | undefined {
  return db
    .prepare("SELECT * FROM sessions WHERE id = ?")
    .get(token) as SessionRow | undefined;
}

/** Refresh a session's sliding window: bump last_seen_at to now and
 *  push expires_at to now + SESSION_TTL_MS. Idempotent; called on
 *  every authed request that found a valid session. */
export function touchSession(db: DatabaseSync, token: string): void {
  const now = Date.now();
  const lastSeen = new Date(now).toISOString();
  const expires = new Date(now + SESSION_TTL_MS).toISOString();
  db.prepare("UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE id = ?").run(
    lastSeen,
    expires,
    token,
  );
}

/** Delete a session row (logout). Idempotent — missing rows are a
 *  no-op, so a stale cookie on a re-logout doesn't throw. */
export function deleteSession(db: DatabaseSync, token: string): void {
  db.prepare("DELETE FROM sessions WHERE id = ?").run(token);
}

/** Has `expires_at` passed? Sessions whose row exists but whose
 *  expiry is in the past are treated as logged out — and should be
 *  swept eventually (a periodic `DELETE WHERE expires_at < ?` is
 *  fine; not v1). */
export function isExpired(session: SessionRow, now: number = Date.now()): boolean {
  return Date.parse(session.expires_at) <= now;
}
