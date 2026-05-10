/**
 * Import a .puz or .ipuz file into the `puzzles` table as a canonical
 * ipuz blob. Used by the CLI script (scripts/import-puzzle.ts) and by
 * tests; not exposed via HTTP.
 *
 * The slug is derived from the input filename (caller's responsibility
 * to keep filenames distinct in their library — we no longer auto-suffix
 * on collision the way the old GAME_DIR scan did). With `force: false`,
 * inserting a slug that already exists is an error.
 */

import { readFileSync } from "node:fs";
import { basename, extname } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { PuzzleState } from "@crossplay/shared";
import { writeIpuz } from "./ipuz.js";
import { detectFormat, parsePuzzleBuffer } from "./format.js";

export type ImportResult = { id: string; replaced: boolean };

/** Shared INSERT/UPDATE for the `puzzles` table. Used by both the
 *  CLI import script and the HTTP upload route. The caller is
 *  responsible for parsing the source buffer to {state, solution}. */
export function insertPuzzleRow(args: {
  db: DatabaseSync;
  id: string;
  state: PuzzleState;
  solution: (string | null)[][];
  replaceIfExists: boolean;
}): { replaced: boolean } {
  const { db, id, state, solution, replaceIfExists } = args;
  const ipuz = writeIpuz(state, solution);
  const meta = state.meta;

  const existing = db
    .prepare("SELECT id FROM puzzles WHERE id = ?")
    .get(id) as { id: string } | undefined;
  if (existing && !replaceIfExists) {
    throw new Error(`puzzle '${id}' already exists (use --force to overwrite)`);
  }

  const now = new Date().toISOString();
  if (existing) {
    db.prepare(
      "UPDATE puzzles SET ipuz=?, title=?, author=?, copyright=?, width=?, height=?, updated_at=? WHERE id=?",
    ).run(ipuz, meta.title, meta.author, meta.copyright, meta.width, meta.height, now, id);
  } else {
    db.prepare(
      "INSERT INTO puzzles (id, ipuz, title, author, copyright, width, height, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(id, ipuz, meta.title, meta.author, meta.copyright, meta.width, meta.height, now, now);
  }
  return { replaced: !!existing };
}

/** Lowercase, runs of non-alphanumerics → `-`, trim. Empty input
 *  becomes "puzzle" so we never produce an empty PK. */
export function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "puzzle"
  );
}

export function importPuzzle(args: {
  db: DatabaseSync;
  path: string;
  force: boolean;
}): ImportResult {
  const { db, path, force } = args;
  const buf = readFileSync(path);
  const stem = basename(path, extname(path));
  const id = slugify(stem);
  const format = detectFormat(path, buf);
  const { state, solution } = parsePuzzleBuffer(id, buf, format);
  // Re-serialize to canonical ipuz so storage is format-uniform — a
  // .puz import lands as the same shape as a native .ipuz import.
  const { replaced } = insertPuzzleRow({
    db,
    id,
    state,
    solution,
    replaceIfExists: force,
  });
  return { id, replaced };
}
