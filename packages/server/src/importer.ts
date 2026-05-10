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
import { parsePuzBuffer } from "./puzzle.js";
import { parseIpuzBuffer, writeIpuz } from "./ipuz.js";

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

/** Extension wins; if it isn't `.puz` or `.ipuz`, sniff for a leading
 *  `{` (BOM-tolerant) and treat as ipuz, else .puz. Mirrors the upload
 *  route's detection in index.ts. */
function detectFormat(filename: string, buffer: Buffer): "puz" | "ipuz" {
  const ext = filename.toLowerCase().match(/\.(puz|ipuz)$/)?.[1];
  if (ext === "ipuz") return "ipuz";
  if (ext === "puz") return "puz";
  let i = 0;
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) i = 3;
  while (
    i < buffer.length &&
    (buffer[i] === 0x20 || buffer[i] === 0x09 || buffer[i] === 0x0a || buffer[i] === 0x0d)
  )
    i++;
  return buffer[i] === 0x7b ? "ipuz" : "puz";
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
  const { state, solution } =
    format === "ipuz" ? parseIpuzBuffer(id, buf) : parsePuzBuffer(id, buf);
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
