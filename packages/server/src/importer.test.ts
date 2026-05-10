import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { openDb } from "./db.js";
import { importPuzzle, slugify } from "./importer.js";

const FIXTURE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");
const SUNDAY_PUZ = resolve(FIXTURE_DIR, "sunday-sample.puz");
const SUNDAY_IPUZ = resolve(FIXTURE_DIR, "sunday-sample.ipuz");

type PuzzleRow = {
  id: string;
  ipuz: string;
  title: string;
  author: string;
  width: number;
  height: number;
  created_at: string;
  updated_at: string;
};

describe("slugify", () => {
  it("lowercases and dashes non-alphanumerics", () => {
    expect(slugify("Sunday Sample!")).toBe("sunday-sample");
    expect(slugify("foo--BAR_baz")).toBe("foo-bar-baz");
  });
  it("falls back to 'puzzle' for empty input", () => {
    expect(slugify("")).toBe("puzzle");
    expect(slugify("---")).toBe("puzzle");
  });
});

describe("importPuzzle", () => {
  it("inserts a .puz file and stores canonical ipuz", () => {
    const db = openDb(":memory:");
    const result = importPuzzle({ db, path: SUNDAY_PUZ, force: false });
    expect(result).toEqual({ id: "sunday-sample", replaced: false });

    const row = db.prepare("SELECT * FROM puzzles WHERE id = ?").get("sunday-sample") as PuzzleRow;
    expect(row.title).toBeTruthy();
    expect(row.width).toBeGreaterThan(0);
    expect(row.height).toBeGreaterThan(0);
    // ipuz column is a JSON string with the canonical shape.
    const parsed = JSON.parse(row.ipuz);
    expect(parsed.kind).toBeDefined();
    expect(row.created_at).toBe(row.updated_at);
    db.close();
  });

  it("inserts a .ipuz file the same way", () => {
    const db = openDb(":memory:");
    const result = importPuzzle({ db, path: SUNDAY_IPUZ, force: false });
    expect(result).toEqual({ id: "sunday-sample", replaced: false });
    const row = db.prepare("SELECT title FROM puzzles WHERE id = ?").get("sunday-sample") as { title: string };
    expect(row.title).toBeTruthy();
    db.close();
  });

  it("rejects re-import without --force", () => {
    const db = openDb(":memory:");
    importPuzzle({ db, path: SUNDAY_PUZ, force: false });
    expect(() => importPuzzle({ db, path: SUNDAY_PUZ, force: false })).toThrow(/already exists/);
    db.close();
  });

  it("overwrites with --force, preserving created_at and bumping updated_at", async () => {
    const db = openDb(":memory:");
    importPuzzle({ db, path: SUNDAY_PUZ, force: false });
    const before = db.prepare("SELECT created_at, updated_at FROM puzzles WHERE id = ?").get("sunday-sample") as { created_at: string; updated_at: string };

    // Wait long enough for ISO timestamp to differ at ms granularity.
    await new Promise((r) => setTimeout(r, 5));

    const result = importPuzzle({ db, path: SUNDAY_PUZ, force: true });
    expect(result).toEqual({ id: "sunday-sample", replaced: true });

    const after = db.prepare("SELECT created_at, updated_at FROM puzzles WHERE id = ?").get("sunday-sample") as { created_at: string; updated_at: string };
    expect(after.created_at).toBe(before.created_at);
    expect(after.updated_at >= before.updated_at).toBe(true);
    db.close();
  });
});
