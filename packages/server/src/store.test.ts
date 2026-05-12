import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openDb } from "./db.js";
import { importPuzzle } from "./importer.js";
import { findOrCreateBoard } from "./boards.js";
import type { WebSocket } from "ws";
import {
  FLUSH_IDLE_MS,
  _clearCacheForTest,
  cachedBoards,
  evictBoard,
  flushAll,
  flushAndEvict,
  flushBoard,
  getOrLoadBoard,
  isBoardLive,
  markDirty,
} from "./store.js";

const FIXTURE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");
const SUNDAY_PUZ = resolve(FIXTURE_DIR, "sunday-sample.puz");

function freshDbWithBoard() {
  const db = openDb(":memory:");
  // Seed a user — findOrCreateBoard now requires an owner under Phase 2.
  db.prepare(
    "INSERT INTO users (handle, handle_lower, password_hash, created_at) VALUES (?, ?, ?, ?)",
  ).run("owner", "owner", "x", "2026-05-12");
  const ownerId = (
    db.prepare("SELECT id FROM users WHERE handle_lower = 'owner'").get() as { id: number }
  ).id;
  importPuzzle({ db, path: SUNDAY_PUZ, force: false });
  const { boardId } = findOrCreateBoard(db, "sunday-sample", ownerId);
  return { db, boardId };
}

beforeEach(() => {
  _clearCacheForTest();
});

afterEach(() => {
  vi.useRealTimers();
  _clearCacheForTest();
});

describe("getOrLoadBoard", () => {
  it("lazy-loads from the DB on first call and caches on subsequent calls", () => {
    const { db, boardId } = freshDbWithBoard();
    const a = getOrLoadBoard(db, boardId);
    const b = getOrLoadBoard(db, boardId);
    expect(a).toBeDefined();
    expect(b).toBe(a); // same cached object
    expect(a!.dirty).toBe(false);
    db.close();
  });

  it("returns undefined for an unknown id", () => {
    const db = openDb(":memory:");
    expect(getOrLoadBoard(db, "no-such-board")).toBeUndefined();
    db.close();
  });
});

describe("markDirty + flush timer", () => {
  it("schedules a flush after FLUSH_IDLE_MS that writes snapshot+chat back", () => {
    vi.useFakeTimers();
    const { db, boardId } = freshDbWithBoard();
    const entry = getOrLoadBoard(db, boardId)!;

    // Mutate live snapshot + append a chat message.
    entry.state.snapshot.version = 42;
    entry.chat.push({ name: "Joel", color: "#1f77b4", text: "hi", ts: 1 });
    markDirty(db, boardId);
    expect(entry.dirty).toBe(true);

    // Just before the timer fires: still dirty, DB unchanged.
    vi.advanceTimersByTime(FLUSH_IDLE_MS - 1);
    expect(entry.dirty).toBe(true);

    // Cross the threshold.
    vi.advanceTimersByTime(1);
    expect(entry.dirty).toBe(false);

    const row = db.prepare("SELECT snapshot, chat FROM boards WHERE id = ?").get(boardId) as { snapshot: string; chat: string };
    expect(JSON.parse(row.snapshot).version).toBe(42);
    expect(JSON.parse(row.chat)).toEqual([{ name: "Joel", color: "#1f77b4", text: "hi", ts: 1 }]);
    db.close();
  });

  it("flushBoard updates fill_percent based on the live snapshot", () => {
    const { db, boardId } = freshDbWithBoard();
    const entry = getOrLoadBoard(db, boardId)!;

    // A freshly-stamped board: column starts at NULL.
    const before = db
      .prepare("SELECT fill_percent FROM boards WHERE id = ?")
      .get(boardId) as { fill_percent: number | null };
    expect(before.fill_percent).toBeNull();

    // Mutate one fillable cell so live differs from initial. Use the
    // first cell-kind we find so this isn't fixture-position-dependent.
    let mutated = false;
    outer: for (const row of entry.state.snapshot.cells) {
      for (const c of row) {
        if (c.kind === "cell") {
          c.fill = "Z";
          mutated = true;
          break outer;
        }
      }
    }
    expect(mutated).toBe(true);
    markDirty(db, boardId);
    flushBoard(db, boardId);

    const after = db
      .prepare("SELECT fill_percent FROM boards WHERE id = ?")
      .get(boardId) as { fill_percent: number | null };
    // We just typed one letter, so it's some integer 0–99 (depends on
    // grid size). Just assert it left NULL behind.
    expect(after.fill_percent).not.toBeNull();
    expect(after.fill_percent).toBeGreaterThanOrEqual(0);
    expect(after.fill_percent).toBeLessThan(100);
    db.close();
  });

  it("resets the timer on each new mutation (idle debounce)", () => {
    vi.useFakeTimers();
    const { db, boardId } = freshDbWithBoard();
    getOrLoadBoard(db, boardId);

    markDirty(db, boardId);
    vi.advanceTimersByTime(FLUSH_IDLE_MS - 1);
    // Second mutation just before flush — timer should reset.
    markDirty(db, boardId);
    vi.advanceTimersByTime(FLUSH_IDLE_MS - 1);

    // Old fire would have happened by now; verify no flush yet.
    const before = db.prepare("SELECT updated_at FROM boards WHERE id = ?").get(boardId) as { updated_at: string };
    // Still cached as dirty (hasn't been written).
    const entry = getOrLoadBoard(db, boardId)!;
    expect(entry.dirty).toBe(true);

    // Cross the new threshold.
    vi.advanceTimersByTime(1);
    expect(entry.dirty).toBe(false);
    const after = db.prepare("SELECT updated_at FROM boards WHERE id = ?").get(boardId) as { updated_at: string };
    expect(after.updated_at).not.toBe(before.updated_at);
    db.close();
  });
});

describe("flushBoard", () => {
  it("is a no-op when the entry is not dirty", () => {
    const { db, boardId } = freshDbWithBoard();
    getOrLoadBoard(db, boardId);
    const before = db.prepare("SELECT updated_at FROM boards WHERE id = ?").get(boardId) as { updated_at: string };
    flushBoard(db, boardId);
    const after = db.prepare("SELECT updated_at FROM boards WHERE id = ?").get(boardId) as { updated_at: string };
    expect(after.updated_at).toBe(before.updated_at);
    db.close();
  });

  it("is a no-op when the entry is not cached", () => {
    const { db, boardId } = freshDbWithBoard();
    // never loaded into cache
    expect(() => flushBoard(db, boardId)).not.toThrow();
    db.close();
  });
});

describe("flushAndEvict", () => {
  it("persists then drops the cached entry", () => {
    vi.useFakeTimers();
    const { db, boardId } = freshDbWithBoard();
    const entry = getOrLoadBoard(db, boardId)!;
    entry.state.snapshot.version = 7;
    markDirty(db, boardId);

    flushAndEvict(db, boardId);

    expect([...cachedBoards()]).toHaveLength(0);
    const row = db.prepare("SELECT snapshot FROM boards WHERE id = ?").get(boardId) as { snapshot: string };
    expect(JSON.parse(row.snapshot).version).toBe(7);

    // Advancing time afterward must not retrigger a flush — the timer
    // should have been canceled by evict.
    vi.advanceTimersByTime(FLUSH_IDLE_MS * 2);
    db.close();
  });
});

describe("flushAll", () => {
  it("drains every dirty entry in the cache", () => {
    const { db, boardId } = freshDbWithBoard();
    const entry = getOrLoadBoard(db, boardId)!;
    entry.state.snapshot.version = 99;
    markDirty(db, boardId);

    flushAll(db);

    expect(entry.dirty).toBe(false);
    const row = db.prepare("SELECT snapshot FROM boards WHERE id = ?").get(boardId) as { snapshot: string };
    expect(JSON.parse(row.snapshot).version).toBe(99);
    db.close();
  });
});

describe("isBoardLive", () => {
  /** Minimal fake WebSocket with a settable readyState. We need the
   *  `OPEN` static constant on each instance because the production
   *  code compares against `s.OPEN` (per-instance per the `ws` API). */
  function fakeSocket(readyState: number): WebSocket {
    return { OPEN: 1, readyState } as unknown as WebSocket;
  }

  it("is false for an unknown board (nothing in the cache)", () => {
    _clearCacheForTest();
    expect(isBoardLive("never-loaded")).toBe(false);
  });

  it("is false when the cached entry has zero sockets", () => {
    const { db, boardId } = freshDbWithBoard();
    getOrLoadBoard(db, boardId); // loads with empty sockets set
    expect(isBoardLive(boardId)).toBe(false);
    db.close();
  });

  it("is true with at least one OPEN socket", () => {
    const { db, boardId } = freshDbWithBoard();
    const entry = getOrLoadBoard(db, boardId)!;
    entry.sockets.add(fakeSocket(1)); // OPEN
    expect(isBoardLive(boardId)).toBe(true);
    db.close();
  });

  it("ignores CLOSING / CLOSED sockets (treats them as gone)", () => {
    const { db, boardId } = freshDbWithBoard();
    const entry = getOrLoadBoard(db, boardId)!;
    entry.sockets.add(fakeSocket(2)); // CLOSING
    entry.sockets.add(fakeSocket(3)); // CLOSED
    expect(isBoardLive(boardId)).toBe(false);
    db.close();
  });
});

describe("evictBoard", () => {
  it("drops without flushing — caller is responsible for persisting first", () => {
    vi.useFakeTimers();
    const { db, boardId } = freshDbWithBoard();
    const entry = getOrLoadBoard(db, boardId)!;
    entry.state.snapshot.version = 13;
    markDirty(db, boardId);

    evictBoard(boardId);

    expect([...cachedBoards()]).toHaveLength(0);
    // version=13 was lost on purpose (raw evict, no flush).
    const row = db.prepare("SELECT snapshot FROM boards WHERE id = ?").get(boardId) as { snapshot: string };
    expect(JSON.parse(row.snapshot).version).not.toBe(13);

    // Pending timer should be canceled — advancing won't write anything.
    vi.advanceTimersByTime(FLUSH_IDLE_MS * 2);
    db.close();
  });
});
