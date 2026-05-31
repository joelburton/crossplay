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

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename, extname } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { Clue, PuzzleState } from "@crossplay/shared";
import { writeIpuz } from "./ipuz.js";
import { detectFormat, parsePuzzleBuffer } from "./format.js";

export type ImportResult = { id: string; replaced: boolean };

/** Stable SHA-256 over a puzzle's *solving content* — solution grid
 *  (with block shape baked in via nulls), the boolean given-mask, and
 *  normalized clue text. Title / author / copyright / notes and the
 *  presentation flags (circled, shaded) are intentionally excluded so
 *  reprints with cosmetic differences collide. Used to dedup the
 *  puzzle library at import time; collisions surface as a hard error,
 *  not a silent replace. */
export function puzzleContentHash(
  state: PuzzleState,
  solution: (string[] | null)[][],
): string {
  const givens = state.snapshot.cells.map((row) =>
    row.map((c) => (c.kind === "cell" ? !!c.given : false)),
  );
  const normClues = (cs: Clue[]) =>
    cs.map((c) => [c.number, c.text.trim().normalize("NFC")] as const);
  const payload = JSON.stringify({
    solution,
    givens,
    across: normClues(state.meta.clues.across),
    down: normClues(state.meta.clues.down),
  });
  return createHash("sha256").update(payload).digest("hex");
}

/** Shared INSERT/UPDATE for the `puzzles` table. Used by both the
 *  CLI import script and the HTTP upload route. The caller is
 *  responsible for parsing the source buffer to {state, solution}. */
export function insertPuzzleRow(args: {
  db: DatabaseSync;
  id: string;
  state: PuzzleState;
  solution: (string[] | null)[][];
  replaceIfExists: boolean;
}): { replaced: boolean } {
  const { db, id, state, solution, replaceIfExists } = args;
  const ipuz = writeIpuz(state, solution);
  const meta = state.meta;
  const hash = puzzleContentHash(state, solution);

  const existing = db
    .prepare("SELECT id FROM puzzles WHERE id = ?")
    .get(id) as { id: string } | undefined;
  if (existing && !replaceIfExists) {
    throw new Error(`puzzle '${id}' already exists (use --force to overwrite)`);
  }

  // Content-level dedup: the same solving experience under a different
  // slug is rejected even with --force. --force is for re-importing
  // the same puzzle at the same slug (hash matches but id matches
  // too, so this query excludes it); using it to plant a duplicate at
  // a new slug would defeat the dedup, so we make the caller delete
  // the other row first.
  const contentDup = db
    .prepare("SELECT id FROM puzzles WHERE content_hash = ? AND id != ?")
    .get(hash, id) as { id: string } | undefined;
  if (contentDup) {
    throw new Error(
      `puzzle content matches existing '${contentDup.id}' — delete that row first if you really want to re-import under '${id}'`,
    );
  }

  const now = new Date().toISOString();
  if (existing) {
    db.prepare(
      "UPDATE puzzles SET ipuz=?, title=?, author=?, copyright=?, width=?, height=?, content_hash=?, updated_at=? WHERE id=?",
    ).run(ipuz, meta.title, meta.author, meta.copyright, meta.width, meta.height, hash, now, id);
  } else {
    db.prepare(
      "INSERT INTO puzzles (id, ipuz, title, author, copyright, width, height, content_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(id, ipuz, meta.title, meta.author, meta.copyright, meta.width, meta.height, hash, now, now);
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
