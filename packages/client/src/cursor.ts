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

export function isOpen(cells: Cell[][], row: number, col: number): boolean {
  if (row < 0 || col < 0) return false;
  if (row >= cells.length) return false;
  const r = cells[row];
  if (!r || col >= r.length) return false;
  return r[col]!.kind === "cell";
}

export function firstOpenCell(cells: Cell[][]): CellPos | null {
  for (let r = 0; r < cells.length; r++) {
    for (let c = 0; c < cells[r]!.length; c++) {
      if (cells[r]![c]!.kind === "cell") return { row: r, col: c };
    }
  }
  return null;
}

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

export function advanceAfterFill(cells: Cell[][], cursor: Cursor): Cursor {
  const { dr, dc } = step(cursor.dir);
  let r = cursor.row + dr;
  let c = cursor.col + dc;
  while (inBounds(cells, r, c)) {
    if (isOpen(cells, r, c)) {
      const cell = cells[r]![c]!;
      if (cell.kind === "cell" && cell.fill == null) {
        return { row: r, col: c, dir: cursor.dir };
      }
    }
    r += dr;
    c += dc;
  }
  return cursor;
}

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
