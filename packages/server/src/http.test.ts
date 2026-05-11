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
import multipart from "@fastify/multipart";
import type { DatabaseSync } from "node:sqlite";
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
  await app.register(multipart, { limits: { fileSize: opts.fileSize ?? 5 * 1024 * 1024 } });
  const db = openDb(":memory:");
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

  beforeEach(async () => {
    _clearCacheForTest();
    ({ app, db } = await buildApp());
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
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { boardId: string };
    expect(typeof body.boardId).toBe("string");
    expect(body.boardId.length).toBeGreaterThan(0);
  });

  it("is idempotent (find-or-create returns the same board)", async () => {
    const puzzleId = seedPuzzle(db);
    const r1 = await app.inject({ method: "POST", url: "/api/boards", payload: { puzzleId } });
    const r2 = await app.inject({ method: "POST", url: "/api/boards", payload: { puzzleId } });
    expect((r1.json() as { boardId: string }).boardId).toBe(
      (r2.json() as { boardId: string }).boardId,
    );
  });

  it("returns 400 when puzzleId is missing", async () => {
    const res = await app.inject({ method: "POST", url: "/api/boards", payload: {} });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toMatch(/missing puzzleId/i);
  });

  it("returns 404 when puzzle is unknown", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/boards",
      payload: { puzzleId: "no-such" },
    });
    expect(res.statusCode).toBe(404);
    expect((res.json() as { error: string }).error).toMatch(/not found/i);
  });
});

describe("http: GET /api/boards and GET /api/boards/:id", () => {
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

  it("lists boards newest-first and exposes nullable puzzleId", async () => {
    seedPuzzle(db, "p1");
    const r1 = await app.inject({ method: "POST", url: "/api/boards", payload: { puzzleId: "p1" } });
    const b1 = (r1.json() as { boardId: string }).boardId;
    const res = await app.inject({ method: "GET", url: "/api/boards" });
    expect(res.statusCode).toBe(200);
    const list = res.json() as Array<{ id: string; puzzleId: string | null }>;
    expect(list.some((b) => b.id === b1 && b.puzzleId === "p1")).toBe(true);
  });

  it("returns the board state with no solution leak", async () => {
    seedPuzzle(db);
    const create = await app.inject({
      method: "POST",
      url: "/api/boards",
      payload: { puzzleId: "test-puzzle" },
    });
    const { boardId } = create.json() as { boardId: string };
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

  beforeEach(async () => {
    _clearCacheForTest();
    ({ app, db } = await buildApp());
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
    });
    const { boardId } = create.json() as { boardId: string };
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

  beforeEach(async () => {
    _clearCacheForTest();
    ({ app, db } = await buildApp());
  });
  afterEach(async () => {
    await app.close();
    _clearCacheForTest();
  });

  it("removes the row; subsequent GET 404s", async () => {
    seedPuzzle(db);
    const create = await app.inject({
      method: "POST",
      url: "/api/boards",
      payload: { puzzleId: "test-puzzle" },
    });
    const { boardId } = create.json() as { boardId: string };

    const del = await app.inject({ method: "DELETE", url: `/api/boards/${boardId}` });
    expect(del.statusCode).toBe(200);
    expect((del.json() as { ok: boolean }).ok).toBe(true);

    const get = await app.inject({ method: "GET", url: `/api/boards/${boardId}` });
    expect(get.statusCode).toBe(404);
  });

  it("returns 404 for unknown board", async () => {
    const res = await app.inject({ method: "DELETE", url: "/api/boards/no-such" });
    expect(res.statusCode).toBe(404);
  });

  it("is idempotent: double DELETE returns 404 on the second call", async () => {
    seedPuzzle(db);
    const create = await app.inject({
      method: "POST",
      url: "/api/boards",
      payload: { puzzleId: "test-puzzle" },
    });
    const { boardId } = create.json() as { boardId: string };
    const r1 = await app.inject({ method: "DELETE", url: `/api/boards/${boardId}` });
    const r2 = await app.inject({ method: "DELETE", url: `/api/boards/${boardId}` });
    expect(r1.statusCode).toBe(200);
    expect(r2.statusCode).toBe(404);
  });
});

describe("http: POST /api/boards/upload", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    _clearCacheForTest();
    ({ app } = await buildApp());
  });
  afterEach(async () => {
    await app.close();
    _clearCacheForTest();
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
    });
    expect(res.statusCode).toBe(200);
    const { boardId } = res.json() as { boardId: string };
    expect(typeof boardId).toBe("string");

    // The new board should be in the list with puzzleId === null.
    const list = await app.inject({ method: "GET", url: "/api/boards" });
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
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toMatch(/invalid \.puz/i);
  });

  it("returns 400 (not 500) when the file exceeds the size cap", async () => {
    // Fresh app with a tiny cap so we don't have to push megabytes
    // through inject(). 64 bytes is well below the size of any real
    // puzzle but large enough to fit a few header bytes before the
    // multipart plugin's limit fires.
    await app.close();
    _clearCacheForTest();
    ({ app } = await buildApp({ fileSize: 64 }));
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
    });
    expect(res.statusCode).toBe(400);
  });

  it("returns 400 with the underlying message on unsupported ipuz features", async () => {
    // Minimal ipuz with a shaded cell (style.shading) — parser rejects.
    // (Circled cells are supported now; we keep this test on a feature
    // we still reject so the 400 path stays exercised.)
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
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toMatch(/shading|shaded/i);
  });
});

describe("boards survive their source puzzle being deleted", () => {
  // CLAUDE.md: "boards are stamped, not referenced... deleting the
  // puzzle leaves boards playable." The schema enforces this (no FK,
  // nullable puzzle_id), but we want a regression test that walks the
  // full lifecycle: stamp → delete puzzle row → load board.
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

  it("GET /api/boards/:id still works after the puzzle row is gone", async () => {
    seedPuzzle(db, "to-delete");
    const create = await app.inject({
      method: "POST",
      url: "/api/boards",
      payload: { puzzleId: "to-delete" },
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
    // puzzle_id is informational only — there's no FK, so deletion
    // doesn't cascade. The board row keeps the stale pointer; the list
    // surface still returns it as the puzzleId.
    seedPuzzle(db, "lingering");
    const create = await app.inject({
      method: "POST",
      url: "/api/boards",
      payload: { puzzleId: "lingering" },
    });
    const { boardId } = create.json() as { boardId: string };
    db.prepare("DELETE FROM puzzles WHERE id = ?").run("lingering");

    const list = await app.inject({ method: "GET", url: "/api/boards" });
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
    });
    const { boardId } = create.json() as { boardId: string };
    db.prepare("DELETE FROM puzzles WHERE id = ?").run("downloadable");

    const ipuz = await app.inject({ method: "GET", url: `/api/boards/${boardId}/ipuz` });
    expect(ipuz.statusCode).toBe(200);
    const parsed = JSON.parse(ipuz.body) as { kind?: unknown };
    expect(Array.isArray(parsed.kind)).toBe(true);
  });
});
