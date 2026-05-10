import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import websocket from "@fastify/websocket";
import { WebSocket, type RawData, type ClientOptions } from "ws";
import type { Cell, PuzzleState, ServerMessage } from "@crossplay/shared";
import { putPuzzle } from "./store.js";
import { registerWsRoutes } from "./ws.js";

// 3-row scratch puzzle: same shape as ws.test.ts uses, but installed into
// the real store so the WS route can find it by id.
function buildPuzzle(): { state: PuzzleState; solution: (string | null)[][]; format: "puz" } {
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
  return {
    state: {
      meta: {
        id: "int",
        title: "",
        author: "",
        copyright: "",
        note: "",
        width: 5,
        height: 3,
        clues: { across: [], down: [] },
      },
      snapshot: { version: 0, cells },
    },
    solution: [
      ["A", "B", null, "C", "D"],
      ["E", "F", "G", "H", "I"],
      [null, null, "J", null, null],
    ],
    format: "puz",
  };
}

async function startServer(opts: { heartbeatIntervalMs?: number } = {}) {
  const app = Fastify();
  await app.register(websocket);
  registerWsRoutes(app, opts);
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
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/puzzles/${id}`, options);
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
    putPuzzle(puzzleId, buildPuzzle());
    const started = await startServer();
    app = started.app;
    port = started.port;
  });

  afterAll(async () => {
    await app.close();
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
    putPuzzle(id, buildPuzzle());

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

  beforeAll(async () => {
    putPuzzle(puzzleId, buildPuzzle());
    // 50ms heartbeat: first tick pings, second tick (100ms in) terminates
    // the connection if no pong arrived. The `ws` client is constructed
    // with autoPong:false below so it stays silent and triggers that path.
    const started = await startServer({ heartbeatIntervalMs: 50 });
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
