/**
 * Auth route tests via Fastify `inject()`. Each test builds a fresh
 * app on `:memory:` so registration / session state never leaks
 * across tests.
 *
 * The auth middleware runs on every request and resolves req.user
 * from the session cookie, so end-to-end cookie round-tripping is
 * exercised in the same place as the route logic.
 */

import { describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import multipart from "@fastify/multipart";
import type { DatabaseSync } from "node:sqlite";
import { registerAuthMiddleware, SESSION_COOKIE } from "./authRoutes.js";
import { openDb } from "./db.js";
import { registerHttpRoutes } from "./http.js";

async function buildApp(): Promise<{ app: FastifyInstance; db: DatabaseSync }> {
  const app = Fastify();
  await app.register(cookie);
  const db = openDb(":memory:");
  registerAuthMiddleware(app, db);
  await app.register(multipart);
  await registerHttpRoutes(app, { db });
  await app.ready();
  return { app, db };
}

function seedInvite(db: DatabaseSync, code = "cryptic-night"): string {
  db.prepare(
    "INSERT INTO invite_codes (code, label, created_at) VALUES (?, ?, ?)",
  ).run(code, "test", "2026-05-12");
  return code;
}

/** Parse the session token out of a Set-Cookie header value (or
 *  array). Returns null if not present. */
function sessionCookieFrom(setCookie: string | string[] | undefined): string | null {
  if (!setCookie) return null;
  const headers = Array.isArray(setCookie) ? setCookie : [setCookie];
  for (const h of headers) {
    const m = h.match(new RegExp(`${SESSION_COOKIE}=([^;]+)`));
    if (m) return m[1]!;
  }
  return null;
}

describe("POST /api/auth/register", () => {
  it("creates a user and sets a session cookie on success", async () => {
    const { app, db } = await buildApp();
    seedInvite(db);
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { handle: "Moth", password: "hunter2", inviteCode: "cryptic-night" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.user.handle).toBe("Moth");
    expect(body.user.isAdmin).toBe(false);
    expect(sessionCookieFrom(res.headers["set-cookie"])).toMatch(/^[0-9a-f]{64}$/);
    await app.close();
  });

  it("matches the invite code case-insensitively", async () => {
    const { app, db } = await buildApp();
    seedInvite(db, "cryptic-night");
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { handle: "moth", password: "hunter2", inviteCode: "CRYPTIC-NIGHT" },
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it("rejects an unknown invite code", async () => {
    const { app, db } = await buildApp();
    seedInvite(db);
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { handle: "moth", password: "hunter2", inviteCode: "no-such" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/invite code/i);
    await app.close();
  });

  it("rejects a malformed handle", async () => {
    const { app, db } = await buildApp();
    seedInvite(db);
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { handle: "moth!", password: "hunter2", inviteCode: "cryptic-night" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/handle/i);
    await app.close();
  });

  it("rejects a short password", async () => {
    const { app, db } = await buildApp();
    seedInvite(db);
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { handle: "moth", password: "abc", inviteCode: "cryptic-night" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/password/i);
    await app.close();
  });

  it("returns 409 on a duplicate handle (case-insensitive)", async () => {
    const { app, db } = await buildApp();
    seedInvite(db);
    await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { handle: "Moth", password: "hunter2", inviteCode: "cryptic-night" },
    });
    const dup = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { handle: "MOTH", password: "another1", inviteCode: "cryptic-night" },
    });
    expect(dup.statusCode).toBe(409);
    await app.close();
  });

  it("preserves the original handle case (signs up as 'Moth', not 'moth')", async () => {
    const { app, db } = await buildApp();
    seedInvite(db);
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { handle: "Moth", password: "hunter2", inviteCode: "cryptic-night" },
    });
    expect(res.json().user.handle).toBe("Moth");
    await app.close();
  });
});

describe("POST /api/auth/login", () => {
  async function setup() {
    const { app, db } = await buildApp();
    seedInvite(db);
    await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { handle: "Moth", password: "hunter2", inviteCode: "cryptic-night" },
    });
    return { app, db };
  }

  it("succeeds with the correct credentials and sets a fresh cookie", async () => {
    const { app } = await setup();
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { handle: "Moth", password: "hunter2" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().user.handle).toBe("Moth");
    expect(sessionCookieFrom(res.headers["set-cookie"])).toMatch(/^[0-9a-f]{64}$/);
    await app.close();
  });

  it("accepts handles case-insensitively", async () => {
    const { app } = await setup();
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { handle: "MOTH", password: "hunter2" },
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it("returns 401 for an unknown handle (no enumeration)", async () => {
    const { app } = await setup();
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { handle: "nope", password: "hunter2" },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toMatch(/wrong handle or password/i);
    await app.close();
  });

  it("returns 401 for the wrong password (same message as unknown handle)", async () => {
    const { app } = await setup();
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { handle: "Moth", password: "wrong-one" },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toMatch(/wrong handle or password/i);
    await app.close();
  });
});

describe("POST /api/auth/logout", () => {
  it("clears the session row + cookie", async () => {
    const { app, db } = await buildApp();
    seedInvite(db);
    const reg = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { handle: "moth", password: "hunter2", inviteCode: "cryptic-night" },
    });
    const token = sessionCookieFrom(reg.headers["set-cookie"])!;
    const before = db
      .prepare("SELECT COUNT(*) AS c FROM sessions WHERE id = ?")
      .get(token) as { c: number };
    expect(before.c).toBe(1);

    const out = await app.inject({
      method: "POST",
      url: "/api/auth/logout",
      cookies: { [SESSION_COOKIE]: token },
    });
    expect(out.statusCode).toBe(200);
    const after = db
      .prepare("SELECT COUNT(*) AS c FROM sessions WHERE id = ?")
      .get(token) as { c: number };
    expect(after.c).toBe(0);
    await app.close();
  });

  it("is idempotent when called without a session", async () => {
    const { app } = await buildApp();
    const res = await app.inject({ method: "POST", url: "/api/auth/logout" });
    expect(res.statusCode).toBe(200);
    await app.close();
  });
});

describe("GET /api/auth/me", () => {
  it("returns the user when authed", async () => {
    const { app, db } = await buildApp();
    seedInvite(db);
    const reg = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { handle: "moth", password: "hunter2", inviteCode: "cryptic-night" },
    });
    const token = sessionCookieFrom(reg.headers["set-cookie"])!;
    const me = await app.inject({
      method: "GET",
      url: "/api/auth/me",
      cookies: { [SESSION_COOKIE]: token },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json().user.handle).toBe("moth");
    await app.close();
  });

  it("returns 401 with no cookie", async () => {
    const { app } = await buildApp();
    const me = await app.inject({ method: "GET", url: "/api/auth/me" });
    expect(me.statusCode).toBe(401);
    await app.close();
  });

  it("returns 401 with a bogus cookie value", async () => {
    const { app } = await buildApp();
    const me = await app.inject({
      method: "GET",
      url: "/api/auth/me",
      cookies: { [SESSION_COOKIE]: "not-a-real-token" },
    });
    expect(me.statusCode).toBe(401);
    await app.close();
  });

  it("does NOT leak the password hash in the response", async () => {
    const { app, db } = await buildApp();
    seedInvite(db);
    const reg = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { handle: "moth", password: "hunter2", inviteCode: "cryptic-night" },
    });
    const token = sessionCookieFrom(reg.headers["set-cookie"])!;
    const me = await app.inject({
      method: "GET",
      url: "/api/auth/me",
      cookies: { [SESSION_COOKIE]: token },
    });
    const body = JSON.stringify(me.json());
    expect(body).not.toMatch(/scrypt/i);
    expect(body).not.toMatch(/password/i);
    await app.close();
  });
});

describe("session middleware sliding expiry", () => {
  it("touches last_seen_at and expires_at on each authed request", async () => {
    const { app, db } = await buildApp();
    seedInvite(db);
    const reg = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { handle: "moth", password: "hunter2", inviteCode: "cryptic-night" },
    });
    const token = sessionCookieFrom(reg.headers["set-cookie"])!;
    const before = db
      .prepare("SELECT last_seen_at, expires_at FROM sessions WHERE id = ?")
      .get(token) as { last_seen_at: string; expires_at: string };

    // Wait a few ms so the timestamp can advance.
    await new Promise((r) => setTimeout(r, 5));
    await app.inject({
      method: "GET",
      url: "/api/auth/me",
      cookies: { [SESSION_COOKIE]: token },
    });

    const after = db
      .prepare("SELECT last_seen_at, expires_at FROM sessions WHERE id = ?")
      .get(token) as { last_seen_at: string; expires_at: string };
    expect(Date.parse(after.last_seen_at)).toBeGreaterThanOrEqual(
      Date.parse(before.last_seen_at),
    );
    expect(Date.parse(after.expires_at)).toBeGreaterThanOrEqual(
      Date.parse(before.expires_at),
    );
    await app.close();
  });
});
