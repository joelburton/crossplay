/**
 * Architecture-enforcing test: the full board lifecycle works with NO
 * row in the `puzzles` table. Boards stamped from an ad-hoc upload have
 * `puzzle_id IS NULL` and must be fully playable on their own — the
 * puzzles table is a curated library, not a load-bearing parent.
 *
 * Each test asserts the puzzles table stays empty throughout. If a
 * future change introduces a hidden join, FK lookup, or "find the
 * source puzzle" assumption, one of these tests will fail.
 *
 * See `project_test_board_without_puzzle.md` and
 * `project_puzzles_vs_boards.md` for the why.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { DatabaseSync } from "node:sqlite";
import { openDb } from "./db.js";
import { writeIpuz } from "./ipuz.js";
import { parsePuzBuffer } from "./puzzle.js";
import {
  PuzzleNotFoundError,
  findOrCreateBoard,
  getBoardState,
  listBoards,
} from "./boards.js";
import {
  _clearCacheForTest,
  evictBoard,
  flushBoard,
  getOrLoadBoard,
  markDirty,
} from "./store.js";
import { applyCheck, applyClear, applyFill, applyReveal } from "./ws.js";

const FIXTURE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");
const SUNDAY_PUZ = resolve(FIXTURE_DIR, "sunday-sample.puz");

/** Mimic the `POST /api/boards/upload` route end-to-end without spinning
 *  up Fastify: parse a fixture, re-serialize to canonical ipuz, insert
 *  a boards row with NULL puzzle_id. Returns `{boardId, ownerId}` —
 *  ownership matters because findOrCreateBoard / listBoards both scope
 *  to the user under Phase 2. */
function uploadFixtureAsBoard(
  db: DatabaseSync,
  path: string,
): { boardId: string; ownerId: number } {
  db.prepare(
    "INSERT INTO users (handle, handle_lower, password_hash, created_at) VALUES (?, ?, ?, ?)",
  ).run("uploader", "uploader", "x", "2026-05-12");
  const ownerId = (
    db
      .prepare("SELECT id FROM users WHERE handle_lower = 'uploader'")
      .get() as { id: number }
  ).id;
  const buffer = readFileSync(path);
  const id = randomUUID();
  const parsed = parsePuzBuffer(id, buffer);
  const ipuz = writeIpuz(parsed.state, parsed.solution);
  const snapshot = JSON.stringify(parsed.state.snapshot);
  const meta = parsed.state.meta;
  const now = new Date().toISOString();
  db.prepare(
    "INSERT INTO boards (id, puzzle_id, ipuz, title, author, snapshot, chat, owner_id, created_at, updated_at) VALUES (?, NULL, ?, ?, ?, ?, '[]', ?, ?, ?)",
  ).run(id, ipuz, meta.title, meta.author, snapshot, ownerId, now, now);
  return { boardId: id, ownerId };
}

function assertNoPuzzles(db: DatabaseSync): void {
  const { c } = db.prepare("SELECT COUNT(*) AS c FROM puzzles").get() as { c: number };
  expect(c).toBe(0);
}

beforeEach(() => {
  _clearCacheForTest();
});

afterEach(() => {
  _clearCacheForTest();
});

describe("board lifecycle with no puzzle row", () => {
  it("upload-as-board persists with puzzle_id NULL and an empty puzzles table", () => {
    const db = openDb(":memory:");
    const { boardId, ownerId } = uploadFixtureAsBoard(db, SUNDAY_PUZ);

    const row = db
      .prepare("SELECT puzzle_id, title, snapshot FROM boards WHERE id = ?")
      .get(boardId) as { puzzle_id: string | null; title: string; snapshot: string };
    expect(row.puzzle_id).toBeNull();
    expect(row.title).toBeTruthy();
    expect(JSON.parse(row.snapshot).cells.length).toBeGreaterThan(0);

    assertNoPuzzles(db);
    db.close();
  });

  it("getBoardState hydrates meta+snapshot without consulting puzzles", () => {
    const db = openDb(":memory:");
    const { boardId, ownerId } = uploadFixtureAsBoard(db, SUNDAY_PUZ);

    const state = getBoardState(db, boardId);
    expect(state).not.toBeNull();
    expect(state!.meta.id).toBe(boardId);
    expect(state!.meta.width).toBeGreaterThan(0);
    expect(state!.snapshot.cells.length).toBe(state!.meta.height);
    expect((state as Record<string, unknown>).solution).toBeUndefined();

    assertNoPuzzles(db);
    db.close();
  });

  it("listBoards exposes the ad-hoc board with puzzleId=null", () => {
    const db = openDb(":memory:");
    const { boardId, ownerId } = uploadFixtureAsBoard(db, SUNDAY_PUZ);

    const list = listBoards(db, ownerId);
    expect(list).toHaveLength(1);
    expect(list[0]!.id).toBe(boardId);
    expect(list[0]!.puzzleId).toBeNull();

    assertNoPuzzles(db);
    db.close();
  });

  it("findOrCreateBoard cannot resolve via the board's id (puzzle lookup only)", () => {
    // Sanity check on the architecture: findOrCreateBoard takes a
    // puzzle id, never a board id. Passing the board id here must
    // raise PuzzleNotFoundError — there's no row in puzzles to find.
    const db = openDb(":memory:");
    const { boardId, ownerId } = uploadFixtureAsBoard(db, SUNDAY_PUZ);
    expect(() => findOrCreateBoard(db, boardId, ownerId)).toThrow(PuzzleNotFoundError);
    assertNoPuzzles(db);
    db.close();
  });

  it("full play path (fill → reveal → check → clear) works against the in-memory cache", () => {
    const db = openDb(":memory:");
    const { boardId, ownerId } = uploadFixtureAsBoard(db, SUNDAY_PUZ);

    const entry = getOrLoadBoard(db, boardId)!;
    expect(entry).toBeDefined();

    // Find the first fillable cell + its known solution letter.
    let target: { row: number; col: number; sol: string } | null = null;
    outer: for (let r = 0; r < entry.state.meta.height; r++) {
      for (let c = 0; c < entry.state.meta.width; c++) {
        const cell = entry.state.snapshot.cells[r]![c]!;
        const sol = entry.solution[r]?.[c];
        if (cell.kind === "cell" && Array.isArray(sol) && sol.length > 0) {
          target = { row: r, col: c, sol: sol[0]! };
          break outer;
        }
      }
    }
    expect(target).not.toBeNull();
    const { row, col, sol } = target!;

    // 1. Fill with a deliberately wrong letter (use Z; if Z is the
    //    solution at this cell, pick Y instead).
    const wrong = sol === "Z" ? "Y" : "Z";
    const fillChange = applyFill(entry, {
      type: "fill",
      row,
      col,
      letter: wrong,
      clientVersion: entry.state.snapshot.version,
    });
    expect(fillChange).not.toBeNull();
    const liveCell = entry.state.snapshot.cells[row]![col]!;
    expect(liveCell.kind === "cell" && liveCell.fill).toBe(wrong);

    // 2. Check at letter scope → marks `wrong`.
    const checkChanges = applyCheck(entry, { type: "check", scope: "letter", row, col });
    expect(checkChanges).toHaveLength(1);
    expect(liveCell.kind === "cell" && liveCell.wrong).toBe(true);

    // 3. Reveal at letter scope → fills the solution, clears `wrong`.
    const revealChanges = applyReveal(entry, { type: "reveal", scope: "letter", row, col });
    expect(revealChanges).toHaveLength(1);
    expect(liveCell.kind === "cell" && liveCell.fill).toBe(sol);
    expect(liveCell.kind === "cell" && liveCell.revealed).toBe(true);
    expect(liveCell.kind === "cell" && liveCell.wrong).toBeUndefined();

    // 4. Clear → restores cell to its initial (empty) state.
    const clearChanges = applyClear(entry);
    expect(clearChanges.length).toBeGreaterThan(0);
    expect(liveCell.kind === "cell" && liveCell.fill).toBeNull();
    expect(liveCell.kind === "cell" && liveCell.revealed).toBeUndefined();

    assertNoPuzzles(db);
    db.close();
  });

  it("survives a restart-style hydration: flush + evict + reload", () => {
    const db = openDb(":memory:");
    const { boardId, ownerId } = uploadFixtureAsBoard(db, SUNDAY_PUZ);

    // Play a move, mark dirty, flush, then evict the cache entry —
    // simulates the process dying after a debounced flush completed.
    const entry = getOrLoadBoard(db, boardId)!;
    let target: { row: number; col: number } | null = null;
    outer: for (let r = 0; r < entry.state.meta.height; r++) {
      for (let c = 0; c < entry.state.meta.width; c++) {
        if (entry.state.snapshot.cells[r]![c]!.kind === "cell") {
          target = { row: r, col: c };
          break outer;
        }
      }
    }
    const { row, col } = target!;
    applyFill(entry, {
      type: "fill",
      row,
      col,
      letter: "Q",
      clientVersion: entry.state.snapshot.version,
    });
    markDirty(db, boardId);
    flushBoard(db, boardId);
    evictBoard(boardId);

    // Reload — a fresh server boot would do exactly this on first
    // ws connect after restart.
    const reloaded = getOrLoadBoard(db, boardId)!;
    expect(reloaded).toBeDefined();
    const reloadedCell = reloaded.state.snapshot.cells[row]![col]!;
    expect(reloadedCell.kind === "cell" && reloadedCell.fill).toBe("Q");
    // Solution survived the round-trip through the ipuz column.
    expect(reloaded.solution[row]?.[col]).toBeTruthy();

    assertNoPuzzles(db);
    db.close();
  });
});
