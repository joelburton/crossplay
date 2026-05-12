import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import multipart from "@fastify/multipart";
import websocket from "@fastify/websocket";
import { WebSocket, type RawData, type ClientOptions } from "ws";
import type { Cell, PuzzleState, ServerMessage } from "@crossplay/shared";
import { openDb } from "./db.js";
import { _clearCacheForTest, _putBoardForTest, type StoredBoard } from "./store.js";
import { registerHttpRoutes } from "./http.js";
import { registerWsRoutes } from "./ws.js";

// 3-row scratch board: installed directly into the in-memory cache via
// the test helper so the WS route's lazy loader finds it without needing
// a real DB row. Shape matches ws.test.ts.
function buildBoard(id: string): StoredBoard {
  const cells: Cell[][] = [
    [
      { kind: "cell", number: 1, fill: null },
      { kind: "cell", number: 2, fill: null },
      { kind: "block" },
      { kind: "cell", number: 3, fill: null },
      { kind: "cell", number: null, fill: null },
    ],
    [
      { kind: "cell", number: 4, fill: null },
      { kind: "cell", number: null, fill: null },
      { kind: "cell", number: 5, fill: null },
      { kind: "cell", number: null, fill: null },
      { kind: "cell", number: null, fill: null },
    ],
    [
      { kind: "block" },
      { kind: "block" },
      { kind: "cell", number: null, fill: null },
      { kind: "block" },
      { kind: "block" },
    ],
  ];
  const state: PuzzleState = {
    meta: {
      id,
      title: "",
      author: "",
      copyright: "",
      note: "",
      width: 5,
      height: 3,
      clues: { across: [], down: [] },
    },
    snapshot: { version: 0, cells },
  };
  const solution = [
    [["A"], ["B"], null, ["C"], ["D"]],
    [["E"], ["F"], ["G"], ["H"], ["I"]],
    [null, null, ["J"], null, null],
  ] satisfies (string[] | null)[][];
  return {
    id,
    state,
    initialSnapshot: JSON.parse(JSON.stringify(state.snapshot)),
    solution,
    chat: [],
    sockets: new Set(),
    recentHellos: new Map(),
    cursorBySocket: new Map(),
    feedbackCounter: 0,
    solved: false,
    dirty: false,
  };
}

async function startServer(opts: { heartbeatIntervalMs?: number; missedPongTolerance?: number } = {}) {
  const app = Fastify();
  await app.register(websocket);
  // The WS route requires a db handle for lazy-load fallback, but our
  // tests pre-populate the cache so the DB is never queried. An
  // in-memory DB satisfies the type.
  const db = openDb(":memory:");
  registerWsRoutes(app, { db, ...opts });
  const address = await app.listen({ port: 0, host: "127.0.0.1" });
  // address looks like "http://127.0.0.1:<port>"
  const port = Number(new URL(address).port);
  return { app, port };
}

// Wrapper around a ws client that buffers every server message into a
// queue from the moment the socket is constructed. Tests pull messages
// out by type via `next("snapshot")` etc. without racing the connect.
type Client = {
  ws: WebSocket;
  queue: ServerMessage[];
  waiters: Array<{ type: ServerMessage["type"]; resolve: (m: ServerMessage) => void }>;
};

function open(port: number, id: string, options?: ClientOptions): Client {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/boards/${id}`, options);
  const queue: ServerMessage[] = [];
  const waiters: Client["waiters"] = [];
  ws.on("message", (data: RawData) => {
    const msg = JSON.parse(data.toString()) as ServerMessage;
    const idx = waiters.findIndex((w) => w.type === msg.type);
    if (idx >= 0) {
      const [w] = waiters.splice(idx, 1);
      w!.resolve(msg);
    } else {
      queue.push(msg);
    }
  });
  return { ws, queue, waiters };
}

function next<T extends ServerMessage["type"]>(
  c: Client,
  type: T,
  timeoutMs = 1000,
): Promise<Extract<ServerMessage, { type: T }>> {
  const idx = c.queue.findIndex((m) => m.type === type);
  if (idx >= 0) {
    const [m] = c.queue.splice(idx, 1);
    return Promise.resolve(m as Extract<ServerMessage, { type: T }>);
  }
  return new Promise((resolve, reject) => {
    const waiter = { type, resolve: resolve as (m: ServerMessage) => void };
    c.waiters.push(waiter);
    setTimeout(() => {
      const i = c.waiters.indexOf(waiter);
      if (i >= 0) {
        c.waiters.splice(i, 1);
        reject(new Error(`timed out waiting for ${type}`));
      }
    }, timeoutMs);
  });
}

function waitOpen(c: Client): Promise<void> {
  return new Promise((resolve, reject) => {
    if (c.ws.readyState === c.ws.OPEN) return resolve();
    c.ws.once("open", () => resolve());
    c.ws.once("error", reject);
  });
}

function waitClose(c: Client, timeoutMs = 2000): Promise<void> {
  return new Promise((resolve, reject) => {
    if (c.ws.readyState === c.ws.CLOSED) return resolve();
    const timer = setTimeout(() => reject(new Error("timed out waiting for close")), timeoutMs);
    c.ws.once("close", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function send(c: Client, msg: unknown): void {
  c.ws.send(JSON.stringify(msg));
}

describe("ws integration", () => {
  let app: FastifyInstance;
  let port: number;
  const puzzleId = "int-room";

  beforeAll(async () => {
    const started = await startServer();
    app = started.app;
    port = started.port;
  });

  beforeEach(async () => {
    // Drain any pending server-side socket close handlers from the
    // previous test before re-installing the cache entry — otherwise
    // a delayed flushAndEvict can race in and delete the fresh entry.
    // Wait for any pending server-side WS close handlers from the
    // previous test to land before installing — flushAndEvict on a
    // late close would otherwise wipe our fresh entry.
    await new Promise((r) => setTimeout(r, 50));
    _clearCacheForTest();
    _putBoardForTest(buildBoard(puzzleId));
  });

  afterAll(async () => {
    await app.close();
    _clearCacheForTest();
  });

  it("sends a snapshot immediately on connect", async () => {
    const c = open(port, puzzleId);
    const snap = await next(c, "snapshot");
    expect(snap.snapshot.version).toBe(0);
    expect(snap.snapshot.cells.length).toBe(3);
    c.ws.close();
    await waitClose(c);
  });

  it("closes the socket when the puzzle id is unknown", async () => {
    const c = open(port, "no-such-puzzle");
    await waitClose(c);
    // The server uses 1008 (policy violation) for this case.
    // The close itself is the assertion.
  });

  it("broadcasts a fill from one client to the other with a bumped version", async () => {
    const a = open(port, puzzleId);
    const b = open(port, puzzleId);
    await Promise.all([waitOpen(a), waitOpen(b)]);
    await Promise.all([next(a, "snapshot"), next(b, "snapshot")]);

    send(a, {
      type: "fill",
      row: 0,
      col: 0,
      letter: "Z",
      clientVersion: 0,
      senderColor: "#1f77b4",
    });
    const update = await next(b, "cellUpdate");
    expect(update.row).toBe(0);
    expect(update.col).toBe(0);
    expect(update.cell.kind).toBe("cell");
    if (update.cell.kind === "cell") {
      expect(update.cell.fill).toBe("Z");
    }
    expect(update.version).toBeGreaterThan(0);
    expect(update.senderColor).toBe("#1f77b4");

    a.ws.close();
    b.ws.close();
    await Promise.all([waitClose(a), waitClose(b)]);
  });

  it("debounces a second hello from the same name within the window", async () => {
    // Fresh room so recentHellos starts empty.
    const id = "int-hello";
    _putBoardForTest(buildBoard(id));

    const observer = open(port, id);
    await next(observer, "snapshot");

    const joiner1 = open(port, id);
    await next(joiner1, "snapshot");

    send(joiner1, { type: "hello", name: "Alice", color: "#1f77b4" });
    const fb = await next(observer, "feedback");
    expect(fb.text).toContain("Alice");
    expect(fb.level).toBe("info");

    const joiner2 = open(port, id);
    await next(joiner2, "snapshot");

    send(joiner2, { type: "hello", name: "Alice", color: "#1f77b4" });
    // No second feedback should arrive within 200ms.
    await expect(next(observer, "feedback", 200)).rejects.toThrow(/timed out/);

    observer.ws.close();
    joiner1.ws.close();
    joiner2.ws.close();
    await Promise.all([waitClose(observer), waitClose(joiner1), waitClose(joiner2)]);
  });

  it("broadcasts chat to peers and preserves the !-prefix verbatim", async () => {
    const a = open(port, puzzleId);
    const b = open(port, puzzleId);
    await Promise.all([next(a, "snapshot"), next(b, "snapshot")]);

    send(a, { type: "chat", name: "Joel", color: "#1f77b4", text: "!hello there" });
    const msg = await next(b, "chatMessage");
    expect(msg.text).toBe("!hello there");
    expect(msg.name).toBe("Joel");
    expect(msg.color).toBe("#1f77b4");

    a.ws.close();
    b.ws.close();
    await Promise.all([waitClose(a), waitClose(b)]);
  });

  it("broadcasts a multi-character rebus fill end-to-end", async () => {
    const a = open(port, puzzleId);
    const b = open(port, puzzleId);
    await Promise.all([waitOpen(a), waitOpen(b)]);
    await Promise.all([next(a, "snapshot"), next(b, "snapshot")]);

    send(a, {
      type: "fill",
      row: 0,
      col: 0,
      letter: "BLOCK",
      clientVersion: 0,
      senderColor: "#1f77b4",
    });
    const update = await next(b, "cellUpdate");
    expect(update.cell.kind).toBe("cell");
    if (update.cell.kind === "cell") {
      expect(update.cell.fill).toBe("BLOCK");
    }
    expect(update.senderColor).toBe("#1f77b4");

    a.ws.close();
    b.ws.close();
    await Promise.all([waitClose(a), waitClose(b)]);
  });

  it("replays existing peers' cursors to a newly-connected socket", async () => {
    // Fresh room so cursorBySocket starts empty.
    const id = "int-replay";
    _putBoardForTest(buildBoard(id));

    // Alice connects and announces a cursor; nobody else is there yet.
    const alice = open(port, id);
    await next(alice, "snapshot");
    send(alice, {
      type: "cursorMoved",
      row: 1,
      col: 2,
      color: "#1f77b4",
      name: "Alice",
    });
    // Give the server a moment to record cursorBySocket.
    await new Promise((r) => setTimeout(r, 20));

    // Bob connects later. He should receive Alice's cursor as a replay
    // right after the snapshot — without Alice having to move again.
    const bob = open(port, id);
    await next(bob, "snapshot");
    const replay = await next(bob, "cursorMoved");
    expect(replay.color).toBe("#1f77b4");
    expect(replay.name).toBe("Alice");
    expect(replay.row).toBe(1);
    expect(replay.col).toBe(2);

    alice.ws.close();
    bob.ws.close();
    await Promise.all([waitClose(alice), waitClose(bob)]);
  });

  it("broadcasts notesShown to all clients", async () => {
    const a = open(port, puzzleId);
    const b = open(port, puzzleId);
    await Promise.all([next(a, "snapshot"), next(b, "snapshot")]);

    send(a, { type: "showNotes" });
    // Both peers receive the notesShown broadcast (sender included).
    await Promise.all([next(a, "notesShown"), next(b, "notesShown")]);

    a.ws.close();
    b.ws.close();
    await Promise.all([waitClose(a), waitClose(b)]);
  });
});

describe("ws integration heartbeat", () => {
  let app: FastifyInstance;
  let port: number;
  const puzzleId = "int-hb";

  beforeEach(async () => {
    // Wait for any pending server-side WS close handlers from the
    // previous test to land before installing — flushAndEvict on a
    // late close would otherwise wipe our fresh entry.
    await new Promise((r) => setTimeout(r, 50));
    _clearCacheForTest();
    _putBoardForTest(buildBoard(puzzleId));
  });

  beforeAll(async () => {
    // 50ms heartbeat + strict (tolerance=1) so the test runs in tens of
    // ms rather than the production 30s × 3 = 90s window. The `ws`
    // client is constructed with autoPong:false below so it stays silent
    // and triggers the missed-pong path.
    const started = await startServer({ heartbeatIntervalMs: 50, missedPongTolerance: 1 });
    app = started.app;
    port = started.port;
  });

  afterAll(async () => {
    await app.close();
  });

  it("terminates a socket that misses a pong", async () => {
    const c = open(port, puzzleId, { autoPong: false });
    await next(c, "snapshot");
    // Two heartbeat ticks (~100ms) plus margin. The server calls
    // socket.terminate(), which closes the client socket.
    await waitClose(c, 2000);
  });
});

// DELETE /api/boards/:id force-closes every open ws socket on the
// board before removing the row. This block mounts the real HTTP
// + WS routes on the same instance so we can drive both sides
// against the same DB and cache.
describe("ws integration: DELETE force-close", () => {
  let app: FastifyInstance;
  let port: number;
  let uploadedBoardId: string;
  let sessionCookie: string;

  beforeAll(async () => {
    app = Fastify();
    const cookie = (await import("@fastify/cookie")).default;
    await app.register(cookie);
    await app.register(multipart, { limits: { fileSize: 5 * 1024 * 1024 } });
    await app.register(websocket);
    const db = openDb(":memory:");
    // Auth middleware runs on every request; mount before routes.
    const { registerAuthMiddleware } = await import("./authRoutes.js");
    registerAuthMiddleware(app, db);
    registerWsRoutes(app, { db });
    await registerHttpRoutes(app, { db });
    const address = await app.listen({ port: 0, host: "127.0.0.1" });
    port = Number(new URL(address).port);

    // Seed an invite + register a user once for the whole describe.
    // We need a session cookie because POST /api/boards/upload now
    // requires auth.
    db.prepare(
      "INSERT INTO invite_codes (code, label, created_at) VALUES (?, ?, ?)",
    ).run("test-invite", "test", "2026-05-12");
    const reg = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { handle: "tester", password: "hunter2", inviteCode: "test-invite" },
    });
    const setCookie = reg.headers["set-cookie"];
    const headers = Array.isArray(setCookie) ? setCookie : [setCookie ?? ""];
    sessionCookie = "";
    for (const h of headers) {
      const m = h?.match(/crossplay_session=([^;]+)/);
      if (m) { sessionCookie = m[1]!; break; }
    }
    if (!sessionCookie) throw new Error("integration setup: no session cookie");
  });

  beforeEach(async () => {
    _clearCacheForTest();
    // Upload a real board so the DELETE route finds a row to remove.
    const buf = readFileSync(resolve(import.meta.dirname, "..", "fixtures", "sunday-sample.puz"));
    const boundary = `----b${Date.now()}`;
    const body = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="sunday-sample.puz"\r\nContent-Type: application/octet-stream\r\n\r\n`,
      ),
      buf,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const res = await app.inject({
      method: "POST",
      url: "/api/boards/upload",
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      payload: body,
      cookies: { crossplay_session: sessionCookie },
    });
    uploadedBoardId = (res.json() as { boardId: string }).boardId;
  });

  afterEach(async () => {
    await new Promise((r) => setTimeout(r, 50));
    _clearCacheForTest();
  });

  afterAll(async () => {
    await app.close();
  });

  it("closes both peers on DELETE and refuses fresh connects afterward", async () => {
    const a = open(port, uploadedBoardId);
    const b = open(port, uploadedBoardId);
    await Promise.all([waitOpen(a), waitOpen(b)]);
    await Promise.all([next(a, "snapshot"), next(b, "snapshot")]);

    const del = await app.inject({
      method: "DELETE",
      url: `/api/boards/${uploadedBoardId}`,
      cookies: { crossplay_session: sessionCookie },
    });
    expect(del.statusCode).toBe(200);

    // Both peers receive the server-initiated close.
    await Promise.all([waitClose(a), waitClose(b)]);

    // Subsequent GET 404s.
    const get = await app.inject({ method: "GET", url: `/api/boards/${uploadedBoardId}` });
    expect(get.statusCode).toBe(404);

    // A fresh WS connect to the deleted id closes immediately
    // (lazy-load sees no row → 1008 policy close).
    const c = open(port, uploadedBoardId);
    await waitClose(c, 2000);
  });
});
