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

import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
