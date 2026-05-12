/**
 * Verifies the SIGTERM/SIGINT shutdown wiring: dirty boards persist to
 * disk before exit, the Fastify app is closed (which closes any open
 * sockets), the exit callback runs exactly once even if the handler
 * fires twice, and errors at any step don't propagate.
 *
 * `closeDb()` is covered by db.test.ts and operates on a module-level
 * singleton our :memory: test handle doesn't touch, so this file
 * doesn't try to re-assert it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { openDb } from "./db.js";
import { insertBoardRow } from "./boards.js";
import { parsePuzBuffer } from "./puzzle.js";
import { writeIpuz } from "./ipuz.js";
import { _clearCacheForTest, getOrLoadBoard, markDirty } from "./store.js";
import { createShutdown } from "./shutdown.js";
import { applyFill } from "./ws.js";

const FIXTURE_DIR = resolve(import.meta.dirname, "..", "fixtures");

async function setup(): Promise<{ app: FastifyInstance; db: DatabaseSync; boardId: string }> {
  const app = Fastify();
  await app.ready();
  const db = openDb(":memory:");
  // Insert a board so the cache has something real to load + flush.
  const buf = readFileSync(resolve(FIXTURE_DIR, "sunday-sample.puz"));
  const parsed = parsePuzBuffer("test", buf);
  const ipuz = writeIpuz(parsed.state, parsed.solution);
  const boardId = "test-board";
  // Seed a user so the board has a non-null owner (matches the
  // application-level rule under Posture A even though shutdown
  // tests don't otherwise exercise auth).
  db.prepare(
    "INSERT INTO users (handle, handle_lower, password_hash, created_at) VALUES (?, ?, ?, ?)",
  ).run("owner", "owner", "x", "2026-05-12");
  const ownerId = (
    db.prepare("SELECT id FROM users WHERE handle_lower = 'owner'").get() as { id: number }
  ).id;
  insertBoardRow({
    db,
    boardId,
    puzzleId: null,
    ipuz,
    title: parsed.state.meta.title,
    author: parsed.state.meta.author,
    copyright: parsed.state.meta.copyright,
    snapshot: JSON.stringify(parsed.state.snapshot),
    ownerId,
  });
  return { app, db, boardId };
}

afterEach(() => {
  _clearCacheForTest();
});

describe("shutdown", () => {
  it("flushes a dirty board before exiting", async () => {
    const { app, db, boardId } = await setup();
    // Lazy-load into cache, mutate, mark dirty (but don't wait the 15s).
    const entry = getOrLoadBoard(db, boardId)!;
    expect(entry).toBeTruthy();
    // Find any fillable cell (the sunday fixture's top-left corner is
    // a hidden block, so we can't hard-code (0, 0)).
    let row0 = -1, col0 = -1;
    outer: for (let r = 0; r < entry.state.meta.height; r++) {
      for (let c = 0; c < entry.state.meta.width; c++) {
        if (entry.state.snapshot.cells[r]![c]!.kind === "cell") {
          row0 = r; col0 = c; break outer;
        }
      }
    }
    expect(row0).toBeGreaterThanOrEqual(0);
    applyFill(entry, {
      type: "fill",
      row: row0,
      col: col0,
      letter: "Z",
      clientVersion: 0,
    });
    markDirty(db, boardId);

    const exit = vi.fn();
    const shutdown = createShutdown({ app, db, exit });
    await shutdown("SIGTERM");

    expect(exit).toHaveBeenCalledExactlyOnceWith(0);

    // The flushed row should reflect the Z fill at the cell we picked.
    const row = db
      .prepare("SELECT snapshot FROM boards WHERE id = ?")
      .get(boardId) as { snapshot: string };
    const snapshot = JSON.parse(row.snapshot) as {
      cells: Array<Array<{ kind: string; fill?: string | null }>>;
    };
    expect(snapshot.cells[row0]![col0]!.fill).toBe("Z");
  });

  it("is idempotent (second call is a no-op)", async () => {
    const { app, db } = await setup();
    const exit = vi.fn();
    const closeSpy = vi.spyOn(app, "close");
    const shutdown = createShutdown({ app, db, exit });

    await shutdown("SIGTERM");
    await shutdown("SIGINT");

    // Both signal handlers fired, but real work + exit happened once.
    expect(exit).toHaveBeenCalledOnce();
    expect(closeSpy).toHaveBeenCalledOnce();
  });

  it("swallows app.close errors and still calls exit", async () => {
    const { app, db } = await setup();
    vi.spyOn(app, "close").mockRejectedValueOnce(new Error("close boom"));
    const exit = vi.fn();
    const errorSpy = vi.spyOn(app.log, "error");

    const shutdown = createShutdown({ app, db, exit });
    await expect(shutdown("SIGTERM")).resolves.toBeUndefined();

    expect(exit).toHaveBeenCalledExactlyOnceWith(0);
    expect(errorSpy).toHaveBeenCalled();
  });

  it("calls app.close so open sockets get torn down", async () => {
    const { app, db } = await setup();
    const closeSpy = vi.spyOn(app, "close");
    const shutdown = createShutdown({ app, db, exit: vi.fn() });

    await shutdown("SIGTERM");

    expect(closeSpy).toHaveBeenCalled();
  });
});
