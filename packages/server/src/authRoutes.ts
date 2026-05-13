/**
 * Auth HTTP surface + session middleware.
 *
 * Three things in one file:
 *   1. A type augmentation on Fastify's request to carry `user`.
 *   2. A `registerAuthMiddleware` hook that resolves the session
 *      cookie on every request and attaches `req.user` (or null).
 *   3. Routes: register / login / logout / me.
 *
 * The middleware runs on every request — it's cheap (one indexed
 * select on a hit, zero on a miss) — and is purely additive. Routes
 * that want to require auth read `req.user` themselves and 401 if
 * it's null. Most routes don't care: anon board play, the public
 * landing page, and library browsing all just ignore `req.user`.
 */

import type { DatabaseSync } from "node:sqlite";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  MIN_PASSWORD_LENGTH,
  type Prefs,
  type UserRow,
  createSession,
  createUser,
  deleteSession,
  findSession,
  findUserByHandle,
  findUserById,
  getUserPrefs,
  hashPassword,
  inviteCodeExists,
  isExpired,
  markHelpSeen,
  touchSession,
  validateHandle,
  verifyPassword,
} from "./auth.js";

declare module "fastify" {
  interface FastifyRequest {
    /** Resolved by the session middleware on every request. null when
     *  the request has no session cookie, or the cookie's session is
     *  expired / unknown. Routes requiring auth check this directly. */
    user: UserRow | null;
  }
}

/** Cookie name carrying the session token. Will change when the app
 *  is renamed; safe to migrate before any real users exist. */
export const SESSION_COOKIE = "crossplay_session";

/** Subset of UserRow safe to send to the client — never the
 *  password hash. `prefs` is the parsed JSON blob (defaults merged in);
 *  `seenHelpAt` is the lifecycle timestamp gating the first-visit help
 *  auto-open (null = unseen). */
export type PublicUser = {
  id: number;
  handle: string;
  email: string | null;
  isAdmin: boolean;
  createdAt: string;
  prefs: Prefs;
  seenHelpAt: string | null;
};

export function toPublicUser(user: UserRow, prefs: Prefs): PublicUser {
  return {
    id: user.id,
    handle: user.handle,
    email: user.email,
    isAdmin: user.is_admin === 1,
    createdAt: user.created_at,
    prefs,
    seenHelpAt: user.seen_help_at,
  };
}

function setSessionCookie(reply: FastifyReply, token: string): void {
  reply.setCookie(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    // Cookie lifetime matches the server-side session TTL. The
    // server-side row is the source of truth either way — a cookie
    // that outlives its row just resolves to req.user = null.
    maxAge: 30 * 24 * 60 * 60,
  });
}

function clearSessionCookie(reply: FastifyReply): void {
  reply.clearCookie(SESSION_COOKIE, { path: "/" });
}

/** Register the onRequest hook that resolves req.user from the
 *  session cookie. Idempotent / safe to register once at boot. */
export function registerAuthMiddleware(app: FastifyInstance, db: DatabaseSync): void {
  app.addHook("onRequest", async (req) => {
    req.user = null;
    const token = req.cookies?.[SESSION_COOKIE];
    if (!token) return;
    const session = findSession(db, token);
    if (!session) return;
    if (isExpired(session)) return;
    const user = findUserById(db, session.user_id);
    if (!user) return;
    req.user = user;
    // Sliding window: bump on every authed request. Cheap (one row
    // update on an indexed PK); means an active user never gets
    // unexpectedly logged out.
    touchSession(db, token);
  });
}

/** Register the auth HTTP routes under the caller's prefix (e.g.
 *  `/api/auth`). Caller is responsible for the prefix. */
export function registerAuthRoutes(app: FastifyInstance, db: DatabaseSync): void {
  // POST /register — create user + session, set cookie. Validates
  // invite code (case-insensitive), handle shape, password length.
  // Returns the public user shape.
  app.post("/register", async (req, reply) => {
    const body = req.body as
      | { handle?: unknown; password?: unknown; inviteCode?: unknown }
      | null;
    if (!body || typeof body !== "object") {
      return reply.code(400).send({ error: "missing body" });
    }
    const handleLower = validateHandle(typeof body.handle === "string" ? body.handle : "");
    if (!handleLower) {
      return reply
        .code(400)
        .send({ error: "Handle must be 2–32 characters: letters, digits, _ or -." });
    }
    const password = typeof body.password === "string" ? body.password : "";
    if (password.length < MIN_PASSWORD_LENGTH) {
      return reply
        .code(400)
        .send({ error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.` });
    }
    const inviteCode =
      typeof body.inviteCode === "string" ? body.inviteCode.trim() : "";
    if (!inviteCode || !inviteCodeExists(db, inviteCode)) {
      return reply
        .code(400)
        .send({ error: "Invite code is required and must be valid." });
    }
    // Handle collision: re-check at insert time because the validation
    // path doesn't reserve. SQLite raises a UNIQUE constraint error;
    // surface as 409. (`handle_lower` is the unique column.)
    if (findUserByHandle(db, handleLower)) {
      return reply.code(409).send({ error: "That handle is taken." });
    }
    const displayHandle =
      typeof body.handle === "string" ? body.handle.trim() : handleLower;
    const userId = createUser(db, {
      handle: displayHandle,
      handleLower,
      passwordHash: hashPassword(password),
      inviteCodeUsed: inviteCode.toLowerCase(),
    });
    const token = createSession(db, userId);
    setSessionCookie(reply, token);
    const user = findUserById(db, userId)!;
    return { user: toPublicUser(user, getUserPrefs(db, user.id)) };
  });

  // POST /login — verify, create session, set cookie.
  app.post("/login", async (req, reply) => {
    const body = req.body as { handle?: unknown; password?: unknown } | null;
    if (!body || typeof body !== "object") {
      return reply.code(400).send({ error: "missing body" });
    }
    const handleLower = validateHandle(typeof body.handle === "string" ? body.handle : "");
    const password = typeof body.password === "string" ? body.password : "";
    // Same error message for "no such handle" and "wrong password" so
    // an attacker can't enumerate handles. Constant-time verify is
    // already in `verifyPassword`.
    const generic = { error: "Wrong handle or password." };
    if (!handleLower) return reply.code(401).send(generic);
    const user = findUserByHandle(db, handleLower);
    if (!user) return reply.code(401).send(generic);
    if (!verifyPassword(password, user.password_hash)) {
      return reply.code(401).send(generic);
    }
    const token = createSession(db, user.id);
    setSessionCookie(reply, token);
    return { user: toPublicUser(user, getUserPrefs(db, user.id)) };
  });

  // POST /logout — idempotent. Clears server-side session + cookie.
  // Returns 200 even if the request had no session, so a
  // double-click on Log Out isn't a 4xx.
  app.post("/logout", async (req, reply) => {
    const token = req.cookies?.[SESSION_COOKIE];
    if (token) deleteSession(db, token);
    clearSessionCookie(reply);
    return { ok: true };
  });

  // GET /me — returns the current user or 401. Cheap probe the
  // client uses on page load to decide which top-level surface to
  // render. Includes the user's prefs (parsed + defaults merged) and
  // their seenHelpAt timestamp, so the client doesn't need a second
  // round-trip to decide whether to auto-open the help dialog.
  app.get("/me", async (req: FastifyRequest, reply) => {
    if (!req.user) return reply.code(401).send({ error: "not logged in" });
    return { user: toPublicUser(req.user, getUserPrefs(db, req.user.id)) };
  });

  // POST /seen-help — mark the user as having seen the help dialog.
  // Idempotent on its own (re-calling just updates the timestamp);
  // the client only calls it on first-open dismissal anyway.
  app.post("/seen-help", async (req, reply) => {
    if (!req.user) return reply.code(401).send({ error: "not logged in" });
    markHelpSeen(db, req.user.id);
    return { ok: true };
  });
}
