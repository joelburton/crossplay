/**
 * Pure cursor and word-navigation logic.
 *
 * Everything here is a pure function over a `Cell[][]` grid plus a
 * `Cursor` (row, col, dir). No React, no DOM, no I/O — which is why this
 * module has the deepest test coverage in the codebase.
 */

import type { Cell, Direction } from "@crossplay/shared";

export type Cursor = {
  row: number;
  col: number;
  dir: Direction;
};

export type CellPos = { row: number; col: number };

export type ArrowKey = "ArrowLeft" | "ArrowRight" | "ArrowUp" | "ArrowDown";

const DELTA: Record<ArrowKey, { dr: number; dc: number; dir: Direction }> = {
  ArrowLeft: { dr: 0, dc: -1, dir: "across" },
  ArrowRight: { dr: 0, dc: 1, dir: "across" },
  ArrowUp: { dr: -1, dc: 0, dir: "down" },
  ArrowDown: { dr: 1, dc: 0, dir: "down" },
};

/** True iff `(row, col)` is inside the grid and is a fillable cell
 *  (not a black block). Used as the "can the cursor be here?" predicate
 *  by every navigation helper below. */
export function isOpen(cells: Cell[][], row: number, col: number): boolean {
  if (row < 0 || col < 0) return false;
  if (row >= cells.length) return false;
  const r = cells[row];
  if (!r || col >= r.length) return false;
  return r[col]!.kind === "cell";
}

/** First open cell scanning row-by-row. Returns `null` only on an
 *  all-blocks grid (which `parsePuzBuffer` won't produce). PuzzleView
 *  uses this as the initial cursor position. */
export function firstOpenCell(cells: Cell[][]): CellPos | null {
  for (let r = 0; r < cells.length; r++) {
    for (let c = 0; c < cells[r]!.length; c++) {
      if (cells[r]![c]!.kind === "cell") return { row: r, col: c };
    }
  }
  return null;
}

/** Find the cell with the given clue number (e.g. `1` for "1 across" /
 *  "1 down"). Used when the user clicks a clue in the side panel. */
export function findCellByNumber(cells: Cell[][], number: number): CellPos | null {
  for (let r = 0; r < cells.length; r++) {
    for (let c = 0; c < (cells[r]?.length ?? 0); c++) {
      const cell = cells[r]![c]!;
      if (cell.kind === "cell" && cell.number === number) {
        return { row: r, col: c };
      }
    }
  }
  return null;
}

/** Walk back to the first cell of the word containing `(row, col)` in
 *  `dir`. If `(row, col)` itself is a block, returns the same coords —
 *  callers should guard with `isOpen` first. */
export function findWordStart(
  cells: Cell[][],
  row: number,
  col: number,
  dir: Direction,
): CellPos {
  const dr = dir === "down" ? -1 : 0;
  const dc = dir === "across" ? -1 : 0;
  let r = row;
  let c = col;
  while (isOpen(cells, r + dr, c + dc)) {
    r += dr;
    c += dc;
  }
  return { row: r, col: c };
}

/** Every cell of the word containing `(row, col)` in `dir`, in word
 *  order. Used to compute the highlighted "current word" cells on the
 *  board. Returns `[]` for a block input. */
export function wordCells(
  cells: Cell[][],
  row: number,
  col: number,
  dir: Direction,
): CellPos[] {
  if (!isOpen(cells, row, col)) return [];
  const start = findWordStart(cells, row, col, dir);
  const dr = dir === "down" ? 1 : 0;
  const dc = dir === "across" ? 1 : 0;
  const out: CellPos[] = [];
  let r = start.row;
  let c = start.col;
  while (isOpen(cells, r, c)) {
    out.push({ row: r, col: c });
    r += dr;
    c += dc;
  }
  return out;
}

/** The number of the clue currently containing `(row, col)` in `dir`
 *  (i.e. the clue number at the start of the word). Used to highlight
 *  the active clue in the clue list and to render the active clue text
 *  in the header. */
export function activeClueNumber(
  cells: Cell[][],
  row: number,
  col: number,
  dir: Direction,
): number | null {
  if (!isOpen(cells, row, col)) return null;
  const start = findWordStart(cells, row, col, dir);
  const cell = cells[start.row]![start.col]!;
  if (cell.kind !== "cell") return null;
  return cell.number;
}

/**
 * Apply an arrow key to the cursor.
 *
 * Two cases:
 *   - The arrow is perpendicular to the current direction: rotate only
 *     (e.g. ArrowDown while moving across just flips dir to "down" and
 *     stays put). This matches every crossword UI convention.
 *   - The arrow matches the direction: move one cell, skipping over
 *     blocks until we find an open cell, or stay put if we hit the
 *     edge.
 */
export function moveCursor(
  cells: Cell[][],
  cursor: Cursor,
  key: ArrowKey,
): Cursor {
  const { dr, dc, dir } = DELTA[key];
  if (dir !== cursor.dir) {
    return { ...cursor, dir };
  }
  let r = cursor.row + dr;
  let c = cursor.col + dc;
  while (
    r >= 0 &&
    c >= 0 &&
    r < cells.length &&
    c < (cells[0]?.length ?? 0)
  ) {
    if (isOpen(cells, r, c)) {
      return { row: r, col: c, dir };
    }
    r += dr;
    c += dc;
  }
  return { ...cursor, dir };
}

function step(dir: Direction): { dr: number; dc: number } {
  return dir === "across" ? { dr: 0, dc: 1 } : { dr: 1, dc: 0 };
}

function inBounds(cells: Cell[][], row: number, col: number): boolean {
  if (row < 0 || col < 0) return false;
  if (row >= cells.length) return false;
  return col < (cells[0]?.length ?? 0);
}

/**
 * Advance the cursor by one cell after the user types a letter.
 *
 * Skips blocks (so typing across a black-square gap continues into the
 * next word) but does **not** skip filled cells — if the next cell
 * already has a letter, the cursor lands there anyway. This is a
 * deliberate decision: see CLAUDE.md "Cursor advances one cell after
 * typing" and memory `project_advance_after_fill.md`. Don't reintroduce
 * skip-filled behavior without a fresh discussion.
 *
 * Stays put if there is no further open cell in the current direction.
 */
export function advanceAfterFill(cells: Cell[][], cursor: Cursor): Cursor {
  const { dr, dc } = step(cursor.dir);
  let r = cursor.row + dr;
  let c = cursor.col + dc;
  while (inBounds(cells, r, c)) {
    if (isOpen(cells, r, c)) {
      return { row: r, col: c, dir: cursor.dir };
    }
    r += dr;
    c += dc;
  }
  return cursor;
}

/** Mirror of `advanceAfterFill` for the Backspace handler in PuzzleView:
 *  one cell back in the cursor's direction, skipping blocks, staying
 *  put if we'd run off the start. PuzzleView uses this when the current
 *  cell is empty (so the user is "deleting" the previous letter). */
export function retreatForBackspace(cells: Cell[][], cursor: Cursor): Cursor {
  const { dr, dc } = step(cursor.dir);
  let r = cursor.row - dr;
  let c = cursor.col - dc;
  while (inBounds(cells, r, c)) {
    if (isOpen(cells, r, c)) {
      return { row: r, col: c, dir: cursor.dir };
    }
    r -= dr;
    c -= dc;
  }
  return cursor;
}

export type ClueStart = {
  row: number;
  col: number;
  dir: Direction;
  number: number;
};

/** Every word-start cell in reading order, across-first then down. Each
 *  entry is a (row, col, dir, number). Used by `jumpClue` to walk the
 *  clue list with Tab / Shift+Tab. */
export function clueStarts(cells: Cell[][]): ClueStart[] {
  const across: ClueStart[] = [];
  const down: ClueStart[] = [];
  for (let r = 0; r < cells.length; r++) {
    for (let c = 0; c < (cells[r]?.length ?? 0); c++) {
      const cell = cells[r]![c]!;
      if (cell.kind !== "cell" || cell.number == null) continue;
      const startsAcross = !isOpen(cells, r, c - 1) && isOpen(cells, r, c + 1);
      const startsDown = !isOpen(cells, r - 1, c) && isOpen(cells, r + 1, c);
      if (startsAcross) across.push({ row: r, col: c, dir: "across", number: cell.number });
      if (startsDown) down.push({ row: r, col: c, dir: "down", number: cell.number });
    }
  }
  return [...across, ...down];
}

/** Jump the cursor to the next (delta=+1) or previous (delta=-1) clue
 *  in the canonical order produced by `clueStarts`. Wraps around at
 *  either end. The cursor's `dir` follows the new clue's direction. */
export function jumpClue(
  cells: Cell[][],
  cursor: Cursor,
  delta: 1 | -1,
): Cursor {
  const starts = clueStarts(cells);
  if (starts.length === 0) return cursor;
  const here = findWordStart(cells, cursor.row, cursor.col, cursor.dir);
  const idx = starts.findIndex(
    (s) => s.row === here.row && s.col === here.col && s.dir === cursor.dir,
  );
  const baseIdx = idx === -1 ? (delta > 0 ? -1 : 0) : idx;
  const nextIdx = (baseIdx + delta + starts.length) % starts.length;
  const target = starts[nextIdx]!;
  return { row: target.row, col: target.col, dir: target.dir };
}
