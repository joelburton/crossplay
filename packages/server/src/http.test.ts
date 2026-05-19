/**
 * HTTP route tests via Fastify `inject()`. Every REST endpoint goes
 * through here so the wire contract is locked in one place; pair this
 * with `ws.integration.test.ts` for the WebSocket side.
 *
 * Each test builds a fresh Fastify app on a `:memory:` SQLite handle —
 * migrations run, but no rows persist between tests. The in-memory
 * store cache is cleared in `beforeEach` so a previous test's lazy-
 * loaded board doesn't leak.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import multipart from "@fastify/multipart";
import type { DatabaseSync } from "node:sqlite";
import { registerAuthMiddleware } from "./authRoutes.js";
import { openDb } from "./db.js";
import { registerHttpRoutes } from "./http.js";
import { insertPuzzleRow } from "./importer.js";
import { parsePuzBuffer } from "./puzzle.js";
import { _clearCacheForTest } from "./store.js";

const FIXTURE_DIR = resolve(import.meta.dirname, "..", "fixtures");

async function buildApp(
  opts: { fileSize?: number } = {},
): Promise<{ app: FastifyInstance; db: DatabaseSync }> {
  const app = Fastify();
  await app.register(cookie);
  const db = openDb(":memory:");
  // Auth middleware reads req.cookies, so the cookie plugin must
  // register first. Order matches index.ts.
  registerAuthMiddleware(app, db);
  await app.register(multipart, { limits: { fileSize: opts.fileSize ?? 5 * 1024 * 1024 } });
  await registerHttpRoutes(app, { db });
  await app.ready();
  return { app, db };
}

/** Seed one puzzle from the Sunday sample fixture. Returns the slug id. */
function seedPuzzle(db: DatabaseSync, id = "test-puzzle"): string {
  const buf = readFileSync(resolve(FIXTURE_DIR, "sunday-sample.puz"));
  const { state, solution } = parsePuzBuffer(id, buf);
  insertPuzzleRow({ db, id, state, solution, replaceIfExists: false });
  return id;
}

/** Register a test user against the live HTTP surface, return the
 *  session cookie value. Most board-route tests now need this to
 *  satisfy the Phase 2 auth gates. The cookies object is the shape
 *  Fastify's inject() accepts as `cookies: {...}`. */
async function seedAuth(
  app: FastifyInstance,
  db: DatabaseSync,
  handle = "tester",
): Promise<{ cookies: Record<string, string>; userId: number }> {
  db.prepare(
    "INSERT OR IGNORE INTO invite_codes (code, label, created_at) VALUES (?, ?, ?)",
  ).run("test-invite", "test", "2026-05-12");
  const res = await app.inject({
    method: "POST",
    url: "/api/auth/register",
    payload: { handle, password: "hunter2", inviteCode: "test-invite" },
  });
  if (res.statusCode !== 200) {
    throw new Error(`seedAuth failed: ${res.statusCode} ${res.body}`);
  }
  const setCookie = res.headers["set-cookie"];
  const headers = Array.isArray(setCookie) ? setCookie : [setCookie ?? ""];
  let token = "";
  for (const h of headers) {
    const m = h?.match(/crossplay_session=([^;]+)/);
    if (m) { token = m[1]!; break; }
  }
  if (!token) throw new Error("seedAuth: no session cookie returned");
  const userId = (
    db.prepare("SELECT id FROM users WHERE handle_lower = ?").get(handle.toLowerCase()) as
      | { id: number }
      | undefined
  )!.id;
  return { cookies: { crossplay_session: token }, userId };
}

/** Build a minimal `multipart/form-data` body with a single file part.
 *  Returns the body + the boundary so the caller can set the header. */
function multipartFile(opts: {
  fieldName: string;
  filename: string;
  contentType: string;
  body: Buffer;
}): { payload: Buffer; contentType: string } {
  const boundary = `----testboundary${Date.now()}`;
  const head = Buffer.from(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="${opts.fieldName}"; filename="${opts.filename}"\r\n` +
      `Content-Type: ${opts.contentType}\r\n\r\n`,
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return {
    payload: Buffer.concat([head, opts.body, tail]),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

/** Build a multipart body with NO file parts — used to exercise the
 *  "missing file" 400 branch without sending a JSON body (which would
 *  hit a different error path inside fastify-multipart). */
function multipartEmpty(): { payload: Buffer; contentType: string } {
  const boundary = `----testboundary${Date.now()}`;
  return {
    payload: Buffer.from(`--${boundary}--\r\n`),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

describe("http: /api/health", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    _clearCacheForTest();
    ({ app } = await buildApp());
  });
  afterEach(async () => {
    await app.close();
    _clearCacheForTest();
  });

  it("returns ok:true", async () => {
    const res = await app.inject({ method: "GET", url: "/api/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });
});

describe("http: /api/puzzles", () => {
  let app: FastifyInstance;
  let db: DatabaseSync;

  beforeEach(async () => {
    _clearCacheForTest();
    ({ app, db } = await buildApp());
  });
  afterEach(async () => {
    await app.close();
    _clearCacheForTest();
  });

  it("returns empty list initially", async () => {
    const res = await app.inject({ method: "GET", url: "/api/puzzles" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
  });

  it("returns the denormalized columns for seeded puzzles", async () => {
    seedPuzzle(db, "sunday");
    const res = await app.inject({ method: "GET", url: "/api/puzzles" });
    expect(res.statusCode).toBe(200);
    const list = res.json() as Array<{ id: string; width: number; height: number; title: string }>;
    expect(list).toHaveLength(1);
    expect(list[0]!.id).toBe("sunday");
    expect(list[0]!.width).toBe(21);
    expect(list[0]!.height).toBe(21);
    expect(typeof list[0]!.title).toBe("string");
  });
});

describe("http: POST /api/boards", () => {
  let app: FastifyInstance;
  let db: DatabaseSync;
  let cookies: Record<string, string>;

  beforeEach(async () => {
    _clearCacheForTest();
    ({ app, db } = await buildApp());
    ({ cookies } = await seedAuth(app, db));
  });
  afterEach(async () => {
    await app.close();
    _clearCacheForTest();
  });

  it("creates a board for a known puzzle", async () => {
    const puzzleId = seedPuzzle(db);
    const res = await app.inject({
      method: "POST",
      url: "/api/boards",
      payload: { puzzleId },
      cookies,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { boardId: string };
    expect(typeof body.boardId).toBe("string");
    expect(body.boardId.length).toBeGreaterThan(0);
  });

  it("is idempotent for the same user (find-or-create returns the same board)", async () => {
    const puzzleId = seedPuzzle(db);
    const r1 = await app.inject({ method: "POST", url: "/api/boards", payload: { puzzleId }, cookies });
    const r2 = await app.inject({ method: "POST", url: "/api/boards", payload: { puzzleId }, cookies });
    expect((r1.json() as { boardId: string }).boardId).toBe(
      (r2.json() as { boardId: string }).boardId,
    );
  });

  it("returns 401 when not logged in", async () => {
    const puzzleId = seedPuzzle(db);
    const res = await app.inject({
      method: "POST",
      url: "/api/boards",
      payload: { puzzleId },
    });
    expect(res.statusCode).toBe(401);
  });

  it("returns 400 when puzzleId is missing", async () => {
    const res = await app.inject({ method: "POST", url: "/api/boards", payload: {}, cookies });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toMatch(/missing puzzleId/i);
  });

  it("returns 404 when puzzle is unknown", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/boards",
      payload: { puzzleId: "no-such" },
      cookies,
    });
    expect(res.statusCode).toBe(404);
    expect((res.json() as { error: string }).error).toMatch(/not found/i);
  });

  it("two users clicking the same puzzle each get their own board", async () => {
    const puzzleId = seedPuzzle(db);
    const a = await seedAuth(app, db, "alice");
    const b = await seedAuth(app, db, "bob");
    const ra = await app.inject({ method: "POST", url: "/api/boards", payload: { puzzleId }, cookies: a.cookies });
    const rb = await app.inject({ method: "POST", url: "/api/boards", payload: { puzzleId }, cookies: b.cookies });
    expect((ra.json() as { boardId: string }).boardId).not.toBe(
      (rb.json() as { boardId: string }).boardId,
    );
  });
});

describe("http: GET /api/boards and GET /api/boards/:id", () => {
  let app: FastifyInstance;
  let db: DatabaseSync;
  let cookies: Record<string, string>;

  beforeEach(async () => {
    _clearCacheForTest();
    ({ app, db } = await buildApp());
    ({ cookies } = await seedAuth(app, db));
  });
  afterEach(async () => {
    await app.close();
    _clearCacheForTest();
  });

  it("lists the user's boards newest-first and exposes nullable puzzleId", async () => {
    seedPuzzle(db, "p1");
    const r1 = await app.inject({ method: "POST", url: "/api/boards", payload: { puzzleId: "p1" }, cookies });
    const b1 = (r1.json() as { boardId: string }).boardId;
    const res = await app.inject({ method: "GET", url: "/api/boards", cookies });
    expect(res.statusCode).toBe(200);
    const list = res.json() as Array<{ id: string; puzzleId: string | null }>;
    expect(list.some((b) => b.id === b1 && b.puzzleId === "p1")).toBe(true);
  });

  it("populates members[] from boards_users and isLive=false for idle boards", async () => {
    seedPuzzle(db);
    const create = await app.inject({
      method: "POST",
      url: "/api/boards",
      payload: { puzzleId: "test-puzzle" },
      cookies,
    });
    const { boardId } = create.json() as { boardId: string };
    // Share with Bob via the route so the join is set up the
    // production way.
    await seedAuth(app, db, "bob");
    await app.inject({
      method: "POST",
      url: `/api/boards/${boardId}/share`,
      payload: { handle: "bob" },
      cookies,
    });

    const res = await app.inject({ method: "GET", url: "/api/boards", cookies });
    const row = (res.json() as Array<{
      id: string;
      members: string[];
      isLive: boolean;
    }>).find((b) => b.id === boardId)!;
    expect(row.members).toEqual(["bob"]);
    expect(row.isLive).toBe(false); // nobody connected
  });

  it("isLive flips to true when a socket is connected to the board's room", async () => {
    seedPuzzle(db);
    const create = await app.inject({
      method: "POST",
      url: "/api/boards",
      payload: { puzzleId: "test-puzzle" },
      cookies,
    });
    const { boardId } = create.json() as { boardId: string };
    // Simulate an open WS connection by loading the cache entry and
    // adding a fake OPEN socket. Avoids spinning up a real ws server.
    const { _putBoardForTest, getOrLoadBoard } = await import("./store.js");
    void _putBoardForTest; // helper exists, but we go via getOrLoadBoard
    const entry = getOrLoadBoard(db, boardId)!;
    entry.sockets.add({ OPEN: 1, readyState: 1 } as unknown as never);

    const res = await app.inject({ method: "GET", url: "/api/boards", cookies });
    const row = (res.json() as Array<{ id: string; isLive: boolean }>).find(
      (b) => b.id === boardId,
    )!;
    expect(row.isLive).toBe(true);
  });

  it("GET /api/boards returns 401 when not authed", async () => {
    const res = await app.inject({ method: "GET", url: "/api/boards" });
    expect(res.statusCode).toBe(401);
  });

  it("returns the board state with no solution leak", async () => {
    seedPuzzle(db);
    const create = await app.inject({
      method: "POST",
      url: "/api/boards",
      payload: { puzzleId: "test-puzzle" },
      cookies,
    });
    const { boardId } = create.json() as { boardId: string };
    // GET /api/boards/:id is public (URL access for any visitor) so
    // no cookies needed here.
    const res = await app.inject({ method: "GET", url: `/api/boards/${boardId}` });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { meta: { width: number }; snapshot: { version: number } };
    expect(body.meta.width).toBe(21);
    expect(body.snapshot.version).toBe(0);
    // No solution-shaped keys anywhere in the response.
    expect(JSON.stringify(body)).not.toMatch(/"solution"/);
  });

  it("returns 404 for unknown board", async () => {
    const res = await app.inject({ method: "GET", url: "/api/boards/no-such" });
    expect(res.statusCode).toBe(404);
  });
});

describe("http: GET /api/boards/:id/solution", () => {
  let app: FastifyInstance;
  let db: DatabaseSync;
  let cookies: Record<string, string>;

  beforeEach(async () => {
    _clearCacheForTest();
    ({ app, db } = await buildApp());
    ({ cookies } = await seedAuth(app, db));
  });
  afterEach(async () => {
    await app.close();
    _clearCacheForTest();
  });

  it("returns the per-cell solution arrays", async () => {
    seedPuzzle(db);
    const create = await app.inject({
      method: "POST",
      url: "/api/boards",
      payload: { puzzleId: "test-puzzle" },
      cookies,
    });
    const { boardId } = create.json() as { boardId: string };
    // Public — same posture as the ipuz download.
    const res = await app.inject({ method: "GET", url: `/api/boards/${boardId}/solution` });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { solution: (string[] | null)[][] };
    expect(Array.isArray(body.solution)).toBe(true);
    expect(body.solution.length).toBeGreaterThan(0);
    // At least one row should contain a non-null entry (open cells exist).
    const hasAnswer = body.solution.some((row) =>
      row.some((cell) => Array.isArray(cell) && cell.length > 0),
    );
    expect(hasAnswer).toBe(true);
  });

  it("returns 404 for unknown board", async () => {
    const res = await app.inject({ method: "GET", url: "/api/boards/no-such/solution" });
    expect(res.statusCode).toBe(404);
  });
});

describe("http: GET /api/boards/:id/ipuz", () => {
  let app: FastifyInstance;
  let db: DatabaseSync;
  let cookies: Record<string, string>;

  beforeEach(async () => {
    _clearCacheForTest();
    ({ app, db } = await buildApp());
    ({ cookies } = await seedAuth(app, db));
  });
  afterEach(async () => {
    await app.close();
    _clearCacheForTest();
  });

  it("returns an ipuz body with a content-disposition attachment header", async () => {
    seedPuzzle(db);
    const create = await app.inject({
      method: "POST",
      url: "/api/boards",
      payload: { puzzleId: "test-puzzle" },
      cookies,
    });
    const { boardId } = create.json() as { boardId: string };
    // Download is public — anyone with the URL can pull the ipuz.
    const res = await app.inject({ method: "GET", url: `/api/boards/${boardId}/ipuz` });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/application\/json/);
    expect(res.headers["content-disposition"]).toMatch(/attachment; filename=".*\.ipuz"/);
    // Body should parse as ipuz JSON with a kind tag.
    const parsed = JSON.parse(res.body) as { kind?: unknown };
    expect(Array.isArray(parsed.kind)).toBe(true);
  });

  it("returns 404 for unknown board", async () => {
    const res = await app.inject({ method: "GET", url: "/api/boards/no-such/ipuz" });
    expect(res.statusCode).toBe(404);
  });
});

describe("http: DELETE /api/boards/:id", () => {
  let app: FastifyInstance;
  let db: DatabaseSync;
  let cookies: Record<string, string>;

  beforeEach(async () => {
    _clearCacheForTest();
    ({ app, db } = await buildApp());
    ({ cookies } = await seedAuth(app, db));
  });
  afterEach(async () => {
    await app.close();
    _clearCacheForTest();
  });

  it("solo member: removes the row + hard-deletes the board (deleted:true); GET 404s", async () => {
    seedPuzzle(db);
    const create = await app.inject({
      method: "POST",
      url: "/api/boards",
      payload: { puzzleId: "test-puzzle" },
      cookies,
    });
    const { boardId } = create.json() as { boardId: string };

    const del = await app.inject({ method: "DELETE", url: `/api/boards/${boardId}`, cookies });
    expect(del.statusCode).toBe(200);
    const body = del.json() as { ok: boolean; deleted: boolean };
    expect(body.ok).toBe(true);
    expect(body.deleted).toBe(true);

    const get = await app.inject({ method: "GET", url: `/api/boards/${boardId}` });
    expect(get.statusCode).toBe(404);
  });

  it("multi-member: leaving drops only my row; board persists; other members keep playing", async () => {
    seedPuzzle(db);
    // Alice (default `cookies`) creates and shares with Bob via the
    // share route, so the membership is wired the same way real users
    // would set it up.
    const create = await app.inject({
      method: "POST",
      url: "/api/boards",
      payload: { puzzleId: "test-puzzle" },
      cookies,
    });
    const { boardId } = create.json() as { boardId: string };
    const bob = await seedAuth(app, db, "bob");
    await app.inject({
      method: "POST",
      url: `/api/boards/${boardId}/share`,
      payload: { handle: "bob" },
      cookies,
    });

    const del = await app.inject({ method: "DELETE", url: `/api/boards/${boardId}`, cookies });
    expect(del.statusCode).toBe(200);
    expect((del.json() as { ok: boolean; deleted: boolean })).toEqual({
      ok: true,
      deleted: false,
    });

    // Board row still exists; alice's membership is gone; bob's remains.
    const row = db.prepare("SELECT id FROM boards WHERE id = ?").get(boardId);
    expect(row).toBeDefined();
    const memberHandles = db
      .prepare(
        "SELECT u.handle FROM boards_users bu JOIN users u ON u.id = bu.user_id WHERE bu.board_id = ?",
      )
      .all(boardId) as Array<{ handle: string }>;
    expect(memberHandles.map((m) => m.handle)).toEqual(["bob"]);

    // Bob can still list and load the board.
    const list = await app.inject({ method: "GET", url: "/api/boards", cookies: bob.cookies });
    const ids = (list.json() as Array<{ id: string }>).map((b) => b.id);
    expect(ids).toContain(boardId);

    // Alice no longer sees it in her list.
    const aliceList = await app.inject({ method: "GET", url: "/api/boards", cookies });
    const aliceIds = (aliceList.json() as Array<{ id: string }>).map((b) => b.id);
    expect(aliceIds).not.toContain(boardId);
  });

  it("multi-member: when the last member leaves, the board is hard-deleted", async () => {
    seedPuzzle(db);
    const create = await app.inject({
      method: "POST",
      url: "/api/boards",
      payload: { puzzleId: "test-puzzle" },
      cookies,
    });
    const { boardId } = create.json() as { boardId: string };
    const bob = await seedAuth(app, db, "bob");
    await app.inject({
      method: "POST",
      url: `/api/boards/${boardId}/share`,
      payload: { handle: "bob" },
      cookies,
    });
    // Alice leaves; board persists with bob.
    await app.inject({ method: "DELETE", url: `/api/boards/${boardId}`, cookies });
    // Bob leaves; he was the last. Board should be deleted.
    const del = await app.inject({
      method: "DELETE",
      url: `/api/boards/${boardId}`,
      cookies: bob.cookies,
    });
    expect(del.statusCode).toBe(200);
    expect((del.json() as { deleted: boolean }).deleted).toBe(true);
    const row = db.prepare("SELECT id FROM boards WHERE id = ?").get(boardId);
    expect(row).toBeUndefined();
  });

  it("returns 401 when not authed", async () => {
    seedPuzzle(db);
    const create = await app.inject({
      method: "POST",
      url: "/api/boards",
      payload: { puzzleId: "test-puzzle" },
      cookies,
    });
    const { boardId } = create.json() as { boardId: string };
    const res = await app.inject({ method: "DELETE", url: `/api/boards/${boardId}` });
    expect(res.statusCode).toBe(401);
  });

  it("returns 404 when caller isn't a member of an existing board", async () => {
    seedPuzzle(db);
    const create = await app.inject({
      method: "POST",
      url: "/api/boards",
      payload: { puzzleId: "test-puzzle" },
      cookies,
    });
    const { boardId } = create.json() as { boardId: string };
    const bob = await seedAuth(app, db, "bob");
    const res = await app.inject({
      method: "DELETE",
      url: `/api/boards/${boardId}`,
      cookies: bob.cookies, // bob has no membership
    });
    expect(res.statusCode).toBe(404);
    // Alice's board is untouched.
    const row = db.prepare("SELECT id FROM boards WHERE id = ?").get(boardId);
    expect(row).toBeDefined();
  });

  it("returns 404 for unknown board", async () => {
    const res = await app.inject({ method: "DELETE", url: "/api/boards/no-such", cookies });
    expect(res.statusCode).toBe(404);
  });

  it("is idempotent: double DELETE returns 404 on the second call", async () => {
    seedPuzzle(db);
    const create = await app.inject({
      method: "POST",
      url: "/api/boards",
      payload: { puzzleId: "test-puzzle" },
      cookies,
    });
    const { boardId } = create.json() as { boardId: string };
    const r1 = await app.inject({ method: "DELETE", url: `/api/boards/${boardId}`, cookies });
    const r2 = await app.inject({ method: "DELETE", url: `/api/boards/${boardId}`, cookies });
    expect(r1.statusCode).toBe(200);
    expect(r2.statusCode).toBe(404);
  });
});

describe("http: POST /api/boards/upload", () => {
  let app: FastifyInstance;
  let db: DatabaseSync;
  let cookies: Record<string, string>;

  beforeEach(async () => {
    _clearCacheForTest();
    ({ app, db } = await buildApp());
    ({ cookies } = await seedAuth(app, db));
  });
  afterEach(async () => {
    await app.close();
    _clearCacheForTest();
  });

  it("returns 401 when not logged in", async () => {
    const { payload, contentType } = multipartEmpty();
    const res = await app.inject({
      method: "POST",
      url: "/api/boards/upload",
      headers: { "content-type": contentType },
      payload,
    });
    expect(res.statusCode).toBe(401);
  });

  it("accepts a .puz upload and creates an ad-hoc board (puzzle_id NULL)", async () => {
    const buf = readFileSync(resolve(FIXTURE_DIR, "sunday-sample.puz"));
    const { payload, contentType } = multipartFile({
      fieldName: "file",
      filename: "sunday-sample.puz",
      contentType: "application/octet-stream",
      body: buf,
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/boards/upload",
      headers: { "content-type": contentType },
      payload,
      cookies,
    });
    expect(res.statusCode).toBe(200);
    const { boardId } = res.json() as { boardId: string };
    expect(typeof boardId).toBe("string");

    // The new board should be in the list with puzzleId === null.
    const list = await app.inject({ method: "GET", url: "/api/boards", cookies });
    const row = (list.json() as Array<{ id: string; puzzleId: string | null }>).find(
      (b) => b.id === boardId,
    );
    expect(row).toBeDefined();
    expect(row!.puzzleId).toBeNull();
  });

  it("accepts a .ipuz upload", async () => {
    const buf = readFileSync(resolve(FIXTURE_DIR, "sunday-sample.ipuz"));
    const { payload, contentType } = multipartFile({
      fieldName: "file",
      filename: "sunday-sample.ipuz",
      contentType: "application/json",
      body: buf,
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/boards/upload",
      headers: { "content-type": contentType },
      payload,
      cookies,
    });
    expect(res.statusCode).toBe(200);
  });

  it("returns 400 when no file part is included", async () => {
    const { payload, contentType } = multipartEmpty();
    const res = await app.inject({
      method: "POST",
      url: "/api/boards/upload",
      headers: { "content-type": contentType },
      payload,
      cookies,
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toMatch(/missing file/i);
  });

  it("returns 400 on garbage file bytes", async () => {
    const { payload, contentType } = multipartFile({
      fieldName: "file",
      filename: "garbage.puz",
      contentType: "application/octet-stream",
      body: Buffer.from("definitely not a puzzle"),
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/boards/upload",
      headers: { "content-type": contentType },
      payload,
      cookies,
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toMatch(/invalid \.puz/i);
  });

  it("returns 400 (not 500) when the file exceeds the size cap", async () => {
    await app.close();
    _clearCacheForTest();
    ({ app, db } = await buildApp({ fileSize: 64 }));
    ({ cookies } = await seedAuth(app, db));
    const { payload, contentType } = multipartFile({
      fieldName: "file",
      filename: "big.puz",
      contentType: "application/octet-stream",
      body: Buffer.alloc(2048, 0x41), // 2KB of 'A'
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/boards/upload",
      headers: { "content-type": contentType },
      payload,
      cookies,
    });
    expect(res.statusCode).toBe(400);
  });

  it("returns 400 with the underlying message on unsupported ipuz features", async () => {
    const ipuz = {
      version: "http://ipuz.org/v2",
      kind: ["http://ipuz.org/crossword#1"],
      title: "shaded",
      author: "test",
      copyright: "",
      dimensions: { width: 2, height: 1 },
      puzzle: [
        [
          { cell: 1, style: { shading: "lightgrey" } },
          2,
        ],
      ],
      solution: [["A", "B"]],
      clues: { Across: [[1, "x"]], Down: [] },
    };
    const buf = Buffer.from(JSON.stringify(ipuz), "utf8");
    const { payload, contentType } = multipartFile({
      fieldName: "file",
      filename: "shaded.ipuz",
      contentType: "application/json",
      body: buf,
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/boards/upload",
      headers: { "content-type": contentType },
      payload,
      cookies,
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toMatch(/shading|shaded/i);
  });
});

describe("http: POST /api/boards/:id/share", () => {
  let app: FastifyInstance;
  let db: DatabaseSync;
  let cookies: Record<string, string>;
  let boardId: string;

  beforeEach(async () => {
    _clearCacheForTest();
    ({ app, db } = await buildApp());
    ({ cookies } = await seedAuth(app, db, "alice"));
    // Caller creates a board they own — that's their membership.
    seedPuzzle(db);
    const create = await app.inject({
      method: "POST",
      url: "/api/boards",
      payload: { puzzleId: "test-puzzle" },
      cookies,
    });
    boardId = (create.json() as { boardId: string }).boardId;
  });
  afterEach(async () => {
    await app.close();
    _clearCacheForTest();
  });

  /** Register a second account so we have someone to share with.
   *  Returns the display handle (case-preserved). The invite code
   *  was seeded by seedAuth already. */
  async function seedSecond(handle: string): Promise<string> {
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { handle, password: "hunter2", inviteCode: "test-invite" },
    });
    if (res.statusCode !== 200) throw new Error(`seedSecond ${handle}: ${res.body}`);
    return handle;
  }

  it("adds a member and returns the canonical handle + alreadyMember:false", async () => {
    await seedSecond("Moth");
    const res = await app.inject({
      method: "POST",
      url: `/api/boards/${boardId}/share`,
      payload: { handle: "moth" }, // case-insensitive resolve
      cookies,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { handle: string; alreadyMember: boolean };
    expect(body.handle).toBe("Moth");
    expect(body.alreadyMember).toBe(false);

    const row = db
      .prepare(
        "SELECT u.handle FROM boards_users bu JOIN users u ON u.id = bu.user_id WHERE bu.board_id = ? AND u.handle_lower = ?",
      )
      .get(boardId, "moth") as { handle: string } | undefined;
    expect(row?.handle).toBe("Moth");
  });

  it("is idempotent: re-share with the same member returns alreadyMember:true", async () => {
    await seedSecond("Moth");
    await app.inject({
      method: "POST",
      url: `/api/boards/${boardId}/share`,
      payload: { handle: "moth" },
      cookies,
    });
    const second = await app.inject({
      method: "POST",
      url: `/api/boards/${boardId}/share`,
      payload: { handle: "MOTH" },
      cookies,
    });
    expect(second.statusCode).toBe(200);
    expect((second.json() as { alreadyMember: boolean }).alreadyMember).toBe(true);

    const count = db
      .prepare("SELECT COUNT(*) AS c FROM boards_users WHERE board_id = ?")
      .get(boardId) as { c: number };
    expect(count.c).toBe(2); // alice (owner) + moth, not 3
  });

  it("sharing with self is a no-op (alreadyMember:true)", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/boards/${boardId}/share`,
      payload: { handle: "alice" },
      cookies,
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { alreadyMember: boolean }).alreadyMember).toBe(true);
  });

  it("returns 401 when not authed", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/boards/${boardId}/share`,
      payload: { handle: "moth" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("returns 403 when caller isn't a member of the board", async () => {
    await seedSecond("Moth");
    const bob = await seedAuth(app, db, "bob");
    const res = await app.inject({
      method: "POST",
      url: `/api/boards/${boardId}/share`,
      payload: { handle: "moth" },
      cookies: bob.cookies, // bob has no membership on alice's board
    });
    expect(res.statusCode).toBe(403);
  });

  it("returns 404 for unknown board", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/boards/no-such/share",
      payload: { handle: "moth" },
      cookies,
    });
    expect(res.statusCode).toBe(404);
  });

  it("returns 404 when the target handle is valid-shape but unknown", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/boards/${boardId}/share`,
      payload: { handle: "ghost" },
      cookies,
    });
    expect(res.statusCode).toBe(404);
    expect((res.json() as { error: string }).error).toMatch(/no user/i);
  });

  it("returns 400 for a malformed handle", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/boards/${boardId}/share`,
      payload: { handle: "!!" },
      cookies,
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toMatch(/handle/i);
  });
});

describe("boards survive their source puzzle being deleted", () => {
  // CLAUDE.md: "boards are stamped, not referenced... deleting the
  // puzzle leaves boards playable." The schema enforces this (no FK,
  // nullable puzzle_id), but we want a regression test that walks the
  // full lifecycle: stamp → delete puzzle row → load board.
  let app: FastifyInstance;
  let db: DatabaseSync;
  let cookies: Record<string, string>;

  beforeEach(async () => {
    _clearCacheForTest();
    ({ app, db } = await buildApp());
    ({ cookies } = await seedAuth(app, db));
  });
  afterEach(async () => {
    await app.close();
    _clearCacheForTest();
  });

  it("GET /api/boards/:id still works after the puzzle row is gone", async () => {
    seedPuzzle(db, "to-delete");
    const create = await app.inject({
      method: "POST",
      url: "/api/boards",
      payload: { puzzleId: "to-delete" },
      cookies,
    });
    const { boardId } = create.json() as { boardId: string };

    // Manually delete the puzzle row (there's no HTTP route for this).
    db.prepare("DELETE FROM puzzles WHERE id = ?").run("to-delete");
    expect(
      db.prepare("SELECT id FROM puzzles WHERE id = ?").get("to-delete"),
    ).toBeUndefined();

    const get = await app.inject({ method: "GET", url: `/api/boards/${boardId}` });
    expect(get.statusCode).toBe(200);
    const body = get.json() as { meta: { width: number } };
    // The board's ipuz blob is self-contained (stamped) — meta survives.
    expect(body.meta.width).toBe(21);
  });

  it("boards.puzzleId reflects the original id even after the puzzle is deleted", async () => {
    seedPuzzle(db, "lingering");
    const create = await app.inject({
      method: "POST",
      url: "/api/boards",
      payload: { puzzleId: "lingering" },
      cookies,
    });
    const { boardId } = create.json() as { boardId: string };
    db.prepare("DELETE FROM puzzles WHERE id = ?").run("lingering");

    const list = await app.inject({ method: "GET", url: "/api/boards", cookies });
    const row = (list.json() as Array<{ id: string; puzzleId: string | null }>).find(
      (b) => b.id === boardId,
    );
    expect(row?.puzzleId).toBe("lingering");
  });

  it("ipuz download still works after the puzzle row is gone", async () => {
    seedPuzzle(db, "downloadable");
    const create = await app.inject({
      method: "POST",
      url: "/api/boards",
      payload: { puzzleId: "downloadable" },
      cookies,
    });
    const { boardId } = create.json() as { boardId: string };
    db.prepare("DELETE FROM puzzles WHERE id = ?").run("downloadable");

    const ipuz = await app.inject({ method: "GET", url: `/api/boards/${boardId}/ipuz` });
    expect(ipuz.statusCode).toBe(200);
    const parsed = JSON.parse(ipuz.body) as { kind?: unknown };
    expect(Array.isArray(parsed.kind)).toBe(true);
  });
});

describe("http: POST /api/boards/fetch-nyt", () => {
  let app: FastifyInstance;
  let db: DatabaseSync;
  let cookies: Record<string, string>;
  let userId: number;

  beforeEach(async () => {
    _clearCacheForTest();
    ({ app, db } = await buildApp());
    ({ cookies, userId } = await seedAuth(app, db));
  });
  afterEach(async () => {
    await app.close();
    _clearCacheForTest();
    vi.unstubAllGlobals();
  });

  /** Set a non-empty stored cookie jar for the test user. The actual
   *  value doesn't matter — the test stubs `fetch` so the jar never
   *  hits the network. */
  function seedNytCookie(jar: Record<string, string> = { "NYT-S": "abc" }): void {
    db.prepare("UPDATE users SET nyt_cookie = ? WHERE id = ?").run(
      JSON.stringify(jar),
      userId,
    );
  }

  /** Minimal NYT v6 response body. One open cell + one Across clue is
   *  enough to exercise the conversion + ipuz round-trip on the way to
   *  the board row. */
  function makeNytPuzzleBody() {
    return {
      body: [
        {
          dimensions: { width: 1, height: 1 },
          cells: [{ type: 1, answer: "A", label: "1" }],
          clues: [{ text: "first", direction: "Across", label: "1" }],
        },
      ],
      title: "Test",
      publicationDate: "2026-05-17",
      constructors: ["Tester"],
      copyright: "2026",
    };
  }

  /** Stub global fetch with a per-URL routing table — `list` for the
   *  v3 puzzles.json endpoint, `puzzle` for v6/puzzle/<id>.json. Returns
   *  a vi.fn so individual tests can assert against call args / counts. */
  function stubNytFetch(routes: {
    list?: () => { status?: number; body: unknown };
    puzzle?: () => { status?: number; body: unknown };
  }) {
    const fn = vi.fn(async (url: string | URL | Request) => {
      const u = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
      let r: { status?: number; body: unknown };
      if (u.includes("/svc/crosswords/v3/puzzles.json")) {
        r = routes.list?.() ?? { body: { results: [] } };
      } else if (u.includes("/svc/crosswords/v6/puzzle/")) {
        r = routes.puzzle?.() ?? { body: makeNytPuzzleBody() };
      } else {
        throw new Error(`unexpected fetch URL in test: ${u}`);
      }
      const status = r.status ?? 200;
      const text = typeof r.body === "string" ? r.body : JSON.stringify(r.body);
      return new Response(text, { status });
    });
    vi.stubGlobal("fetch", fn);
    return fn;
  }

  it("creates a board and adds the caller as a member on the happy path", async () => {
    seedNytCookie();
    stubNytFetch({
      list: () => ({
        body: {
          results: [
            { puzzle_id: 12345, print_date: "2026-05-17", format_type: "Normal" },
          ],
        },
      }),
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/boards/fetch-nyt",
      payload: { date: "2026-05-17" },
      cookies,
    });
    expect(res.statusCode).toBe(200);
    const { boardId } = res.json() as { boardId: string };
    expect(typeof boardId).toBe("string");
    const row = db
      .prepare("SELECT title, owner_id, puzzle_id FROM boards WHERE id = ?")
      .get(boardId) as { title: string; owner_id: number; puzzle_id: string | null };
    expect(row.owner_id).toBe(userId);
    expect(row.puzzle_id).toBeNull(); // matches the upload-route pattern
    expect(row.title).toMatch(/NYT Sun 5\/17\/26/);
    const member = db
      .prepare("SELECT 1 AS ok FROM boards_users WHERE board_id = ? AND user_id = ?")
      .get(boardId, userId);
    expect(member).toBeTruthy();
  });

  it("returns 401 when not logged in", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/boards/fetch-nyt",
      payload: { date: "2026-05-17" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("returns 400 with a clear message when the user has no stored cookie", async () => {
    // No seedNytCookie call — column stays NULL.
    const res = await app.inject({
      method: "POST",
      url: "/api/boards/fetch-nyt",
      payload: { date: "2026-05-17" },
      cookies,
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toMatch(/no nyt cookie/i);
  });

  it("returns 400 when the date is missing or malformed", async () => {
    seedNytCookie();
    for (const payload of [{}, { date: "" }, { date: "5/17/26" }, { date: "2026-5-17" }]) {
      const res = await app.inject({
        method: "POST",
        url: "/api/boards/fetch-nyt",
        payload,
        cookies,
      });
      expect(res.statusCode).toBe(400);
    }
  });

  it("returns 400 when the stored cookie is malformed JSON", async () => {
    db.prepare("UPDATE users SET nyt_cookie = ? WHERE id = ?").run(
      "not json",
      userId,
    );
    const res = await app.inject({
      method: "POST",
      url: "/api/boards/fetch-nyt",
      payload: { date: "2026-05-17" },
      cookies,
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toMatch(/malformed/i);
  });

  it("returns 404 when NYT publishes no Normal puzzle for that date", async () => {
    seedNytCookie();
    stubNytFetch({ list: () => ({ body: { results: [] } }) });
    const res = await app.inject({
      method: "POST",
      url: "/api/boards/fetch-nyt",
      payload: { date: "2026-05-17" },
      cookies,
    });
    expect(res.statusCode).toBe(404);
    expect((res.json() as { error: string }).error).toMatch(/no nyt crossword/i);
  });

  it("returns 502 when NYT serves a bot challenge (non-JSON 200)", async () => {
    seedNytCookie();
    stubNytFetch({
      list: () => ({ body: "<html>access denied</html>" }),
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/boards/fetch-nyt",
      payload: { date: "2026-05-17" },
      cookies,
    });
    expect(res.statusCode).toBe(502);
    expect((res.json() as { error: string }).error).toMatch(/cookie.*expired/i);
  });

  it("returns 502 when NYT responds with 403 (cookie outright rejected)", async () => {
    seedNytCookie();
    stubNytFetch({
      list: () => ({ status: 403, body: { error: "forbidden" } }),
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/boards/fetch-nyt",
      payload: { date: "2026-05-17" },
      cookies,
    });
    expect(res.statusCode).toBe(502);
    expect((res.json() as { error: string }).error).toMatch(/rejected|expired/i);
  });
});

describe("auth: POST /api/auth/nyt-cookie", () => {
  let app: FastifyInstance;
  let db: DatabaseSync;
  let cookies: Record<string, string>;
  let userId: number;

  beforeEach(async () => {
    _clearCacheForTest();
    ({ app, db } = await buildApp());
    ({ cookies, userId } = await seedAuth(app, db));
  });
  afterEach(async () => {
    await app.close();
    _clearCacheForTest();
  });

  /** Build base64-of-JSON for the route's `{cookie}` body. Mirrors
   *  what dump-nyt-cookies emits. */
  function b64(obj: unknown): string {
    return Buffer.from(JSON.stringify(obj), "utf8").toString("base64");
  }

  it("saves a base64-encoded cookie blob and returns the decoded jar", async () => {
    const payload = { cookie: b64({ "NYT-S": "abc", "nyt-a": "xyz" }) };
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/nyt-cookie",
      payload,
      cookies,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      hasNytCookie: boolean;
      cookie: Record<string, string> | null;
    };
    expect(body.hasNytCookie).toBe(true);
    expect(body.cookie).toEqual({ "NYT-S": "abc", "nyt-a": "xyz" });
    const stored = (
      db.prepare("SELECT nyt_cookie FROM users WHERE id = ?").get(userId) as {
        nyt_cookie: string | null;
      }
    ).nyt_cookie;
    expect(stored).toBe(payload.cookie);
  });

  it("clears the column when cookie is null and reports hasNytCookie=false", async () => {
    db.prepare("UPDATE users SET nyt_cookie = ? WHERE id = ?").run("preexisting", userId);
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/nyt-cookie",
      payload: { cookie: null },
      cookies,
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { hasNytCookie: boolean }).hasNytCookie).toBe(false);
    const stored = (
      db.prepare("SELECT nyt_cookie FROM users WHERE id = ?").get(userId) as {
        nyt_cookie: string | null;
      }
    ).nyt_cookie;
    expect(stored).toBeNull();
  });

  it("treats empty string the same as null (clears)", async () => {
    db.prepare("UPDATE users SET nyt_cookie = ? WHERE id = ?").run("preexisting", userId);
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/nyt-cookie",
      payload: { cookie: "" },
      cookies,
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { hasNytCookie: boolean }).hasNytCookie).toBe(false);
  });

  it("rejects a base64 string that decodes to non-JSON with a clear message", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/nyt-cookie",
      payload: { cookie: Buffer.from("hello world").toString("base64") },
      cookies,
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toMatch(/valid JSON/i);
  });

  it("rejects when the decoded jar is empty", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/nyt-cookie",
      payload: { cookie: b64({}) },
      cookies,
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toMatch(/empty/i);
  });

  it("returns 401 when not logged in", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/nyt-cookie",
      payload: { cookie: b64({ "NYT-S": "abc" }) },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe("auth: GET /api/auth/nyt-cookie", () => {
  let app: FastifyInstance;
  let db: DatabaseSync;
  let cookies: Record<string, string>;
  let userId: number;

  beforeEach(async () => {
    _clearCacheForTest();
    ({ app, db } = await buildApp());
    ({ cookies, userId } = await seedAuth(app, db));
  });
  afterEach(async () => {
    await app.close();
    _clearCacheForTest();
  });

  it("returns the decoded jar when the column is populated", async () => {
    // Round-trip via the POST route so we exercise the actual storage
    // format (base64), not a hand-crafted DB write.
    const b64 = Buffer.from(JSON.stringify({ "NYT-S": "abc" })).toString("base64");
    await app.inject({
      method: "POST",
      url: "/api/auth/nyt-cookie",
      payload: { cookie: b64 },
      cookies,
    });
    const res = await app.inject({
      method: "GET",
      url: "/api/auth/nyt-cookie",
      cookies,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ cookie: { "NYT-S": "abc" } });
  });

  it("returns {cookie: null} when the column is NULL", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/auth/nyt-cookie",
      cookies,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ cookie: null });
  });

  it("surfaces a parse error when the stored value is malformed", async () => {
    // Sneak past the POST-time validation by writing directly to the DB,
    // simulating a corrupted / legacy-shape row.
    db.prepare("UPDATE users SET nyt_cookie = ? WHERE id = ?").run("not json", userId);
    const res = await app.inject({
      method: "GET",
      url: "/api/auth/nyt-cookie",
      cookies,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { cookie: unknown; error?: string };
    expect(body.cookie).toBeNull();
    expect(body.error).toMatch(/valid JSON|object of/i);
  });

  it("returns 401 when not logged in", async () => {
    const res = await app.inject({ method: "GET", url: "/api/auth/nyt-cookie" });
    expect(res.statusCode).toBe(401);
  });
});

describe("auth: hasNytCookie on PublicUser", () => {
  let app: FastifyInstance;
  let db: DatabaseSync;
  let cookies: Record<string, string>;
  let userId: number;

  beforeEach(async () => {
    _clearCacheForTest();
    ({ app, db } = await buildApp());
    ({ cookies, userId } = await seedAuth(app, db));
  });
  afterEach(async () => {
    await app.close();
    _clearCacheForTest();
  });

  it("reports hasNytCookie=false when the column is NULL", async () => {
    const res = await app.inject({ method: "GET", url: "/api/auth/me", cookies });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { user: { hasNytCookie: boolean } }).user.hasNytCookie).toBe(
      false,
    );
  });

  it("reports hasNytCookie=true once the column is populated", async () => {
    db.prepare("UPDATE users SET nyt_cookie = ? WHERE id = ?").run(
      '{"NYT-S":"x"}',
      userId,
    );
    const res = await app.inject({ method: "GET", url: "/api/auth/me", cookies });
    expect((res.json() as { user: { hasNytCookie: boolean } }).user.hasNytCookie).toBe(
      true,
    );
  });
});

describe("auth: PATCH /api/auth/prefs", () => {
  let app: FastifyInstance;
  let db: DatabaseSync;
  let cookies: Record<string, string>;
  let userId: number;

  beforeEach(async () => {
    _clearCacheForTest();
    ({ app, db } = await buildApp());
    ({ cookies, userId } = await seedAuth(app, db));
  });
  afterEach(async () => {
    await app.close();
    _clearCacheForTest();
  });

  it("stores a valid #rrggbb color and returns the merged prefs", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: "/api/auth/prefs",
      payload: { color: "#3B82F6" },
      cookies,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ prefs: { color: "#3b82f6" } });
    // Round-trip via /me to confirm the public-user shape carries it.
    const me = await app.inject({ method: "GET", url: "/api/auth/me", cookies });
    expect((me.json() as { user: { prefs: { color?: string } } }).user.prefs.color)
      .toBe("#3b82f6");
  });

  it("rejects malformed colors with a clear message", async () => {
    for (const bad of ["red", "#abc", "#12345g", "not a color", 123]) {
      const res = await app.inject({
        method: "PATCH",
        url: "/api/auth/prefs",
        payload: { color: bad },
        cookies,
      });
      expect(res.statusCode).toBe(400);
      expect((res.json() as { error: string }).error).toMatch(/#rrggbb/i);
    }
  });

  it("clears the pref when color is null (drops from stored JSON)", async () => {
    // Set, then clear, then verify it doesn't come back.
    await app.inject({
      method: "PATCH",
      url: "/api/auth/prefs",
      payload: { color: "#ff0000" },
      cookies,
    });
    const cleared = await app.inject({
      method: "PATCH",
      url: "/api/auth/prefs",
      payload: { color: null },
      cookies,
    });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json()).toEqual({ prefs: {} });
    // Stored JSON should not contain the key (so the default merge
    // resolves to undefined).
    const stored = (
      db.prepare("SELECT prefs FROM users WHERE id = ?").get(userId) as {
        prefs: string | null;
      }
    ).prefs;
    expect(stored).not.toContain("color");
  });

  it("ignores unknown keys (forward-compat with newer clients)", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: "/api/auth/prefs",
      payload: { color: "#ff0000", unknownPref: "value" },
      cookies,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ prefs: { color: "#ff0000" } });
  });

  it("returns 401 when not logged in", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: "/api/auth/prefs",
      payload: { color: "#3b82f6" },
    });
    expect(res.statusCode).toBe(401);
  });
});
