import { copyFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { openDb } from "./db.js";
import { importPuzzle, puzzleContentHash, slugify } from "./importer.js";
import { parseIpuzBuffer } from "./ipuz.js";

const FIXTURE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");
const SUNDAY_PUZ = resolve(FIXTURE_DIR, "sunday-sample.puz");
const SUNDAY_IPUZ = resolve(FIXTURE_DIR, "sunday-sample.ipuz");
const MOTH_PUZ = resolve(FIXTURE_DIR, "a-very-moth-puzzle.puz");

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

  it("stores a content_hash on insert", () => {
    const db = openDb(":memory:");
    importPuzzle({ db, path: SUNDAY_PUZ, force: false });
    const row = db
      .prepare("SELECT content_hash FROM puzzles WHERE id = ?")
      .get("sunday-sample") as { content_hash: string };
    expect(row.content_hash).toMatch(/^[0-9a-f]{64}$/);
    db.close();
  });

  it("rejects a content collision under a different slug, even with --force", () => {
    const db = openDb(":memory:");
    importPuzzle({ db, path: SUNDAY_PUZ, force: false });
    // Copy the same .puz to a different filename so slugify produces a
    // different slug but the parsed content is identical.
    const dupPath = resolve(tmpdir(), `sunday-clone-${process.pid}-${Date.now()}.puz`);
    copyFileSync(SUNDAY_PUZ, dupPath);
    expect(() => importPuzzle({ db, path: dupPath, force: false })).toThrow(
      /content matches existing 'sunday-sample'/,
    );
    expect(() => importPuzzle({ db, path: dupPath, force: true })).toThrow(
      /content matches existing 'sunday-sample'/,
    );
    db.close();
  });

  it("two different puzzles produce different content_hash values", () => {
    const db = openDb(":memory:");
    importPuzzle({ db, path: SUNDAY_PUZ, force: false });
    importPuzzle({ db, path: MOTH_PUZ, force: false });
    const rows = db
      .prepare("SELECT id, content_hash FROM puzzles ORDER BY id")
      .all() as Array<{ id: string; content_hash: string }>;
    expect(rows).toHaveLength(2);
    expect(rows[0]!.content_hash).not.toBe(rows[1]!.content_hash);
    db.close();
  });

  it("puzzleContentHash ignores title / author / copyright but tracks clue text", () => {
    const buf = (() => {
      const db = openDb(":memory:");
      importPuzzle({ db, path: SUNDAY_PUZ, force: false });
      const r = db
        .prepare("SELECT ipuz FROM puzzles WHERE id = ?")
        .get("sunday-sample") as { ipuz: string };
      db.close();
      return r.ipuz;
    })();
    const base = parseIpuzBuffer("x", Buffer.from(buf, "utf8"));
    const h0 = puzzleContentHash(base.state, base.solution);

    // Mutate metadata only — hash should stay the same.
    const meta1 = {
      ...base.state,
      meta: {
        ...base.state.meta,
        title: "totally different title",
        author: "someone else",
        copyright: "different copyright",
        note: "different note",
      },
    };
    expect(puzzleContentHash(meta1, base.solution)).toBe(h0);

    // Mutate one clue — hash should change.
    const meta2 = {
      ...base.state,
      meta: {
        ...base.state.meta,
        clues: {
          ...base.state.meta.clues,
          across: [
            { ...base.state.meta.clues.across[0]!, text: "rewritten" },
            ...base.state.meta.clues.across.slice(1),
          ],
        },
      },
    };
    expect(puzzleContentHash(meta2, base.solution)).not.toBe(h0);
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
