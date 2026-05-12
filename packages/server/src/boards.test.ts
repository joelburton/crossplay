import { describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { openDb } from "./db.js";
import { importPuzzle } from "./importer.js";
import {
  PuzzleNotFoundError,
  deleteBoard,
  findOrCreateBoard,
  getBoardState,
  listBoards,
} from "./boards.js";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const FIXTURE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");
const SUNDAY_PUZ = resolve(FIXTURE_DIR, "sunday-sample.puz");
const MOTH_PUZ = resolve(FIXTURE_DIR, "a-very-moth-puzzle.puz");

function freshDb() {
  const db = openDb(":memory:");
  return db;
}

/** Insert a user row directly so tests have an ownerId to pass.
 *  Skips the auth/route plumbing — these are pure DB tests. */
function seedUser(db: DatabaseSync, handle = "owner"): number {
  db.prepare(
    "INSERT INTO users (handle, handle_lower, password_hash, created_at) VALUES (?, ?, ?, ?)",
  ).run(handle, handle.toLowerCase(), "x", "2026-05-12");
  return (
    db.prepare("SELECT id FROM users WHERE handle_lower = ?").get(handle.toLowerCase()) as {
      id: number;
    }
  ).id;
}

describe("findOrCreateBoard", () => {
  it("creates a new board for a known puzzle and returns newlyCreated=true", () => {
    const db = freshDb();
    const userId = seedUser(db);
    importPuzzle({ db, path: SUNDAY_PUZ, force: false });
    const result = findOrCreateBoard(db, "sunday-sample", userId);
    expect(result.newlyCreated).toBe(true);
    expect(result.boardId).toMatch(/^[0-9a-f-]{36}$/i);

    const row = db.prepare("SELECT puzzle_id, title, owner_id FROM boards WHERE id = ?").get(result.boardId) as { puzzle_id: string; title: string; owner_id: number };
    expect(row.puzzle_id).toBe("sunday-sample");
    expect(row.title).toBeTruthy();
    expect(row.owner_id).toBe(userId);
    db.close();
  });

  it("returns the existing board on the second call (one-per-(user, puzzle))", () => {
    const db = freshDb();
    const userId = seedUser(db);
    importPuzzle({ db, path: SUNDAY_PUZ, force: false });
    const a = findOrCreateBoard(db, "sunday-sample", userId);
    const b = findOrCreateBoard(db, "sunday-sample", userId);
    expect(a.boardId).toBe(b.boardId);
    expect(a.newlyCreated).toBe(true);
    expect(b.newlyCreated).toBe(false);

    const count = db.prepare("SELECT COUNT(*) AS c FROM boards").get() as { c: number };
    expect(count.c).toBe(1);
    db.close();
  });

  it("two different users clicking the same puzzle each get their own board", () => {
    const db = freshDb();
    const userA = seedUser(db, "alice");
    const userB = seedUser(db, "bob");
    importPuzzle({ db, path: SUNDAY_PUZ, force: false });
    const a = findOrCreateBoard(db, "sunday-sample", userA);
    const b = findOrCreateBoard(db, "sunday-sample", userB);
    expect(a.boardId).not.toBe(b.boardId);

    const count = db.prepare("SELECT COUNT(*) AS c FROM boards").get() as { c: number };
    expect(count.c).toBe(2);
    db.close();
  });

  it("treats different puzzles as different boards", () => {
    const db = freshDb();
    const userId = seedUser(db);
    importPuzzle({ db, path: SUNDAY_PUZ, force: false });
    importPuzzle({ db, path: MOTH_PUZ, force: false });
    const a = findOrCreateBoard(db, "sunday-sample", userId);
    const b = findOrCreateBoard(db, "a-very-moth-puzzle", userId);
    expect(a.boardId).not.toBe(b.boardId);
    db.close();
  });

  it("throws PuzzleNotFoundError for an unknown puzzleId", () => {
    const db = freshDb();
    const userId = seedUser(db);
    expect(() => findOrCreateBoard(db, "no-such-puzzle", userId)).toThrow(PuzzleNotFoundError);
    db.close();
  });
});

describe("getBoardState", () => {
  it("returns meta + snapshot for a known board, no solution field", () => {
    const db = freshDb();
    const userId = seedUser(db);
    importPuzzle({ db, path: SUNDAY_PUZ, force: false });
    const { boardId } = findOrCreateBoard(db, "sunday-sample", userId);
    const state = getBoardState(db, boardId);
    expect(state).not.toBeNull();
    expect(state!.meta.title).toBeTruthy();
    expect(state!.snapshot.cells.length).toBeGreaterThan(0);
    expect((state as Record<string, unknown>).solution).toBeUndefined();
    db.close();
  });

  it("reflects the live snapshot from the column, not the initial one", () => {
    const db = freshDb();
    const userId = seedUser(db);
    importPuzzle({ db, path: SUNDAY_PUZ, force: false });
    const { boardId } = findOrCreateBoard(db, "sunday-sample", userId);

    // Mutate snapshot directly: bump version + put a letter in [0][0].
    const initial = getBoardState(db, boardId)!;
    const cells = initial.snapshot.cells.map((row) => row.slice());
    cells[0]![0] = { kind: "cell", number: null, fill: "Z" };
    const updated = { version: 99, cells };
    db.prepare("UPDATE boards SET snapshot = ? WHERE id = ?").run(JSON.stringify(updated), boardId);

    const after = getBoardState(db, boardId)!;
    expect(after.snapshot.version).toBe(99);
    const c00 = after.snapshot.cells[0]![0]!;
    expect(c00.kind === "cell" && c00.fill).toBe("Z");
    db.close();
  });

  it("returns null for an unknown id", () => {
    const db = freshDb();
    expect(getBoardState(db, "no-such-board")).toBeNull();
    db.close();
  });
});

describe("listBoards", () => {
  it("orders by updated_at DESC and exposes nullable puzzleId", async () => {
    const db = freshDb();
    const userId = seedUser(db);
    importPuzzle({ db, path: SUNDAY_PUZ, force: false });
    importPuzzle({ db, path: MOTH_PUZ, force: false });

    const a = findOrCreateBoard(db, "sunday-sample", userId).boardId;
    await new Promise((r) => setTimeout(r, 5));
    const b = findOrCreateBoard(db, "a-very-moth-puzzle", userId).boardId;

    const list = listBoards(db, userId);
    expect(list.length).toBe(2);
    expect(list[0]!.id).toBe(b); // newer first
    expect(list[1]!.id).toBe(a);
    expect(list[0]!.puzzleId).toBe("a-very-moth-puzzle");
    db.close();
  });

  it("exposes fillPercent (NULL for freshly stamped boards → NEW on the home page)", () => {
    const db = freshDb();
    const userId = seedUser(db);
    importPuzzle({ db, path: SUNDAY_PUZ, force: false });
    findOrCreateBoard(db, "sunday-sample", userId);
    const list = listBoards(db, userId);
    expect(list).toHaveLength(1);
    expect(list[0]!.fillPercent).toBeNull();
    db.close();
  });

  it("includes ad-hoc boards (puzzleId IS NULL) owned by the user", () => {
    const db = freshDb();
    const userId = seedUser(db);
    // Simulate an upload-as-board insert: no puzzle row, NULL puzzle_id.
    const now = new Date().toISOString();
    db.prepare(
      "INSERT INTO boards (id, puzzle_id, ipuz, title, author, snapshot, chat, owner_id, created_at, updated_at) VALUES (?, NULL, '{}', 'Ad hoc', '', '{\"version\":0,\"cells\":[]}', '[]', ?, ?, ?)",
    ).run("adhoc-1", userId, now, now);

    const puzzleCount = db.prepare("SELECT COUNT(*) AS c FROM puzzles").get() as { c: number };
    expect(puzzleCount.c).toBe(0); // no puzzle row exists

    const list = listBoards(db, userId);
    expect(list.length).toBe(1);
    expect(list[0]!.id).toBe("adhoc-1");
    expect(list[0]!.puzzleId).toBeNull();
    db.close();
  });

  it("never includes another user's boards", () => {
    const db = freshDb();
    const alice = seedUser(db, "alice");
    const bob = seedUser(db, "bob");
    importPuzzle({ db, path: SUNDAY_PUZ, force: false });
    findOrCreateBoard(db, "sunday-sample", alice);
    findOrCreateBoard(db, "sunday-sample", bob);

    expect(listBoards(db, alice)).toHaveLength(1);
    expect(listBoards(db, bob)).toHaveLength(1);
    expect(listBoards(db, alice)[0]!.id).not.toBe(listBoards(db, bob)[0]!.id);
    db.close();
  });

  it("never includes anon-era boards (owner_id IS NULL)", () => {
    const db = freshDb();
    const userId = seedUser(db);
    const now = new Date().toISOString();
    db.prepare(
      "INSERT INTO boards (id, puzzle_id, ipuz, title, author, snapshot, chat, owner_id, created_at, updated_at) VALUES (?, NULL, '{}', 'Orphan', '', '{}', '[]', NULL, ?, ?)",
    ).run("anon-1", now, now);
    expect(listBoards(db, userId)).toHaveLength(0);
    db.close();
  });
});

describe("deleteBoard", () => {
  it("removes the row and reports existed=true", () => {
    const db = freshDb();
    const userId = seedUser(db);
    importPuzzle({ db, path: SUNDAY_PUZ, force: false });
    const { boardId } = findOrCreateBoard(db, "sunday-sample", userId);

    const result = deleteBoard(db, boardId);
    expect(result.existed).toBe(true);

    const row = db.prepare("SELECT id FROM boards WHERE id = ?").get(boardId);
    expect(row).toBeUndefined();

    // Puzzle row is untouched — deleting a board doesn't touch its source.
    const puzzle = db.prepare("SELECT id FROM puzzles WHERE id = ?").get("sunday-sample");
    expect(puzzle).toBeDefined();

    db.close();
  });

  it("returns existed=false for an unknown id (no throw)", () => {
    const db = freshDb();
    const result = deleteBoard(db, "no-such-board");
    expect(result.existed).toBe(false);
    db.close();
  });

  it("removes only the targeted row", () => {
    const db = freshDb();
    const userId = seedUser(db);
    importPuzzle({ db, path: SUNDAY_PUZ, force: false });
    importPuzzle({ db, path: MOTH_PUZ, force: false });
    const a = findOrCreateBoard(db, "sunday-sample", userId).boardId;
    const b = findOrCreateBoard(db, "a-very-moth-puzzle", userId).boardId;

    deleteBoard(db, a);

    expect(db.prepare("SELECT id FROM boards WHERE id = ?").get(a)).toBeUndefined();
    expect(db.prepare("SELECT id FROM boards WHERE id = ?").get(b)).toBeDefined();
    db.close();
  });
});
