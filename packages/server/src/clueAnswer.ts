/**
 * Resolve a clue (number + direction) into the context the Explain
 * feature needs: the clue text, the canonical answer string, the
 * player's current fill, whether the fill is complete and correct, and
 * the enumeration (e.g. "(4,3)") derived from word-break / hyphen
 * marks. Pure — no I/O, no Gemini, no cache.
 *
 * Reused word-walk logic is intentionally duplicated from `ws.ts`
 * rather than exported from there — keeping that file's
 * already-large surface narrow, and this helper free to evolve
 * independently.
 */

import type { Cell, Direction } from "@crossplay/shared";
import type { StoredBoard } from "./store.js";
import { fillMatchesSolution } from "./ws.js";

/** Slice a setter's note down to just the entry for `(number,
 *  direction)`. Our setters' note format (per project memory):
 *
 *    ACROSS
 *    1 anag. 2 two meanings. 5 ...
 *    DOWN
 *    1 ... 3 ...
 *
 *  Section headers may be on their own line or inline. Per-clue
 *  entries are introduced by the clue number followed by a space or
 *  period. We return the substring from the number up to the next
 *  number-introduced entry (or end of section). Returns "" if the
 *  note shape doesn't match or the clue isn't found — callers should
 *  fall through to "no setter note" rather than leaking the whole
 *  block (which would spoil other clues).
 */
export function sliceNoteForClue(
  fullNote: string,
  number: number,
  direction: "across" | "down",
): string {
  const text = fullNote.trim();
  if (!text) return "";

  // Locate ACROSS / DOWN section markers (case-insensitive,
  // word-boundary). If neither header is present, give up — the
  // note is freeform prose and slicing would be a guess.
  const acrossRe = /\bACROSS\b/i;
  const downRe = /\bDOWN\b/i;
  const acrossIdx = text.search(acrossRe);
  const downIdx = text.search(downRe);
  if (acrossIdx === -1 && downIdx === -1) return "";

  let sectionStart: number;
  let sectionEnd: number;
  if (direction === "across") {
    if (acrossIdx === -1) return "";
    sectionStart = acrossIdx + "ACROSS".length;
    sectionEnd = downIdx > acrossIdx ? downIdx : text.length;
  } else {
    if (downIdx === -1) return "";
    sectionStart = downIdx + "DOWN".length;
    sectionEnd = acrossIdx > downIdx ? acrossIdx : text.length;
  }
  const section = text.slice(sectionStart, sectionEnd);

  // Find the entry for `number`. An entry starts at "N " or "N." at
  // the start of the section or after whitespace/punctuation, and
  // runs until the next such introducer or section end. Numbers
  // inside an entry (e.g. "21st" or "10 in Roman") are protected by
  // requiring a word-boundary before the number.
  const entryRe = new RegExp(`(?:^|[\\s.])${number}(?=[\\s.])`, "g");
  let match: RegExpExecArray | null = null;
  let m: RegExpExecArray | null;
  while ((m = entryRe.exec(section))) {
    match = m;
    break;
  }
  if (!match) return "";
  const start = match.index + (match[0].startsWith(`${number}`) ? 0 : 1);

  // Find the next clue-number introducer after this one to delimit
  // the entry. Any 1–3 digit run preceded by whitespace/period and
  // followed by whitespace/period qualifies — same rule as above.
  const nextRe = /(?:[\s.])\d{1,3}(?=[\s.])/g;
  nextRe.lastIndex = start + 1;
  const next = nextRe.exec(section);
  const end = next ? next.index : section.length;

  return section.slice(start, end).trim();
}

export type ClueExplainContext = {
  clueText: string;
  /** Canonical answer string — the primary (first) solution per cell,
   *  concatenated. For Schrödinger cells, only the primary appears
   *  here; the prompt explains the answer the player sees. */
  answer: string;
  /** What the player currently has in the clue's cells, concatenated. */
  playerFill: string;
  /** True iff every cell of the clue has a non-empty fill. */
  allFilled: boolean;
  /** True iff every filled cell matches an accepted solution. */
  fillCorrect: boolean;
  /** Lengths separated by commas (or hyphens at hyphen marks),
   *  wrapped in parens. E.g. "(7)", "(4,3)", "(3-2)". */
  enumeration: string;
};

export type ResolveResult =
  | { ok: true; context: ClueExplainContext }
  | { ok: false; reason: "clue_not_found" };

export function resolveClueForExplain(
  entry: StoredBoard,
  number: number,
  direction: Direction,
): ResolveResult {
  const { meta, snapshot } = entry.state;
  const clueList = direction === "across" ? meta.clues.across : meta.clues.down;
  const clue = clueList.find((c) => c.number === number);
  if (!clue) return { ok: false, reason: "clue_not_found" };

  const start = findClueStart(snapshot.cells, number);
  if (!start) return { ok: false, reason: "clue_not_found" };

  const cells = walkWord(snapshot.cells, start.row, start.col, direction);
  if (cells.length === 0) return { ok: false, reason: "clue_not_found" };

  const sol = entry.solution;
  let answer = "";
  let playerFill = "";
  let allFilled = true;
  let fillCorrect = true;
  for (const { row, col } of cells) {
    const cell = snapshot.cells[row]![col]! as Extract<Cell, { kind: "cell" }>;
    const sols = sol[row]?.[col] ?? null;
    answer += sols && sols[0] ? sols[0] : "";
    const f = cell.fill ?? "";
    playerFill += f;
    if (!f) allFilled = false;
    if (!fillMatchesSolution(f, sols)) fillCorrect = false;
  }

  return {
    ok: true,
    context: {
      clueText: clue.text,
      answer,
      playerFill,
      allFilled,
      fillCorrect,
      enumeration: buildEnumeration(snapshot.cells, cells, direction),
    },
  };
}

/** Locate the (row, col) of the cell whose `number` matches. Returns
 *  null if no fillable cell carries that number (malformed request
 *  from the client). */
function findClueStart(
  cells: Cell[][],
  number: number,
): { row: number; col: number } | null {
  for (let r = 0; r < cells.length; r++) {
    const row = cells[r]!;
    for (let c = 0; c < row.length; c++) {
      const cell = row[c]!;
      if (cell.kind === "cell" && cell.number === number) return { row: r, col: c };
    }
  }
  return null;
}

function isOpen(cells: Cell[][], r: number, c: number): boolean {
  if (r < 0 || c < 0 || r >= cells.length) return false;
  const row = cells[r]!;
  if (c >= row.length) return false;
  return row[c]!.kind === "cell";
}

function walkWord(
  cells: Cell[][],
  row: number,
  col: number,
  dir: Direction,
): { row: number; col: number }[] {
  if (!isOpen(cells, row, col)) return [];
  const dr = dir === "down" ? 1 : 0;
  const dc = dir === "across" ? 1 : 0;
  const out: { row: number; col: number }[] = [];
  let r = row;
  let c = col;
  while (isOpen(cells, r, c)) {
    out.push({ row: r, col: c });
    r += dr;
    c += dc;
  }
  return out;
}

/** Produce e.g. "(7)", "(4,3)", "(3-2)". Splits on `markRight` (for
 *  across) or `markBottom` (for down) on every non-last cell of the
 *  clue. "break" yields a comma; "hyphen" yields a hyphen. */
function buildEnumeration(
  cells: Cell[][],
  word: { row: number; col: number }[],
  dir: Direction,
): string {
  const segments: { len: number; sep: "," | "-" }[] = [];
  let run = 0;
  for (let i = 0; i < word.length; i++) {
    run++;
    const { row, col } = word[i]!;
    const cell = cells[row]![col]! as Extract<Cell, { kind: "cell" }>;
    const isLast = i === word.length - 1;
    const mark = dir === "across" ? cell.markRight : cell.markBottom;
    if (!isLast && (mark === "break" || mark === "hyphen")) {
      segments.push({ len: run, sep: mark === "hyphen" ? "-" : "," });
      run = 0;
    } else if (isLast) {
      segments.push({ len: run, sep: "," });
    }
  }
  if (segments.length === 0) return `(${word.length})`;
  let out = "";
  for (let i = 0; i < segments.length; i++) {
    out += segments[i]!.len.toString();
    if (i < segments.length - 1) out += segments[i]!.sep;
  }
  return `(${out})`;
}
