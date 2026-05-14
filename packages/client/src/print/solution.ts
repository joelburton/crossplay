/**
 * Solution / "answer key" PDF generator. Shares title + grid geometry
 * with the puzzle PDF (`computeLayout`, `drawTitle`, `drawGrid`); the
 * only difference at the grid layer is a synthetic snapshot where each
 * open cell carries the canonical solution letter (or full rebus) as
 * its `fill`. The clue regions are repurposed to flow the puzzle's
 * `note` block — useful for cryptics, where notes explain the wordplay.
 */

import { jsPDF } from "jspdf";
import type { Cell, GridSnapshot, PuzzleState } from "@crossplay/shared";
import { computeLayout, continuationRegions, type Rect } from "./layout";
import { drawTitle } from "./title";
import { drawGrid } from "./grid";
import { CLUE_LINE_HEIGHT, CLUE_SIZE, FONT_SERIF } from "./fonts";

/** Per-cell solution. Matches the server's StoredBoard.solution shape:
 *  null for blocks, otherwise `[canonical, ...alternates]`. We only
 *  consume element 0 (the canonical answer). */
export type Solution = (string[] | null)[][];

const PARA_GAP = 6;

export async function generateSolutionPdf(
  state: PuzzleState,
  solution: Solution,
): Promise<Blob> {
  const { meta } = state;
  const doc = new jsPDF({ orientation: "portrait", unit: "pt", format: "letter" });

  const layout = computeLayout(meta.width);

  drawTitle(doc, meta, layout.titleRect);
  drawGrid(doc, buildSolvedSnapshot(state.snapshot, solution), layout.gridRect);
  drawNotes(doc, meta.note, layout.regions, layout.continuationCols);

  return doc.output("blob");
}

/** Build a snapshot where every open cell's `fill` is the canonical
 *  solution. `given` and `pencil` are stripped — on a uniformly-filled
 *  answer grid the per-given underline is noisy, and any pencil
 *  guesses the player made shouldn't override the canonical answer's
 *  styling. */
function buildSolvedSnapshot(snapshot: GridSnapshot, solution: Solution): GridSnapshot {
  const cells: Cell[][] = [];
  for (let r = 0; r < snapshot.cells.length; r++) {
    const src = snapshot.cells[r]!;
    const row: Cell[] = [];
    for (let c = 0; c < src.length; c++) {
      const cell = src[c]!;
      if (cell.kind === "block") {
        row.push(cell);
        continue;
      }
      const answer = solution[r]?.[c]?.[0] ?? null;
      row.push({ ...cell, fill: answer, given: undefined, pencil: undefined });
    }
    cells.push(row);
  }
  return { version: snapshot.version, cells };
}

/** Flow `note` through `pageOneRegions`, spilling onto continuation
 *  pages (full-content-width N-column layout) when needed. Paragraph
 *  breaks come from any newline run in the source; an empty / missing
 *  note draws nothing (and the PDF is just title + solved grid). */
function drawNotes(
  doc: jsPDF,
  note: string,
  pageOneRegions: Rect[],
  continuationCols: number,
): void {
  if (!note || !note.trim()) return;
  if (pageOneRegions.length === 0) return;

  doc.setFont(FONT_SERIF, "normal");
  doc.setFontSize(CLUE_SIZE);

  // All regions on a given layout (and the matching continuation
  // columns) share a width within rounding — wrap once against the
  // first region's width; see the comment in generator.ts.
  const wrapWidth = pageOneRegions[0]!.w;
  if (wrapWidth <= 0) return;

  const paragraphs = note
    .split(/\n+/)
    .map((s) => s.trim())
    .filter(Boolean);

  type Item = { kind: "line"; text: string; height: number } | { kind: "gap"; height: number };
  const items: Item[] = [];
  for (let i = 0; i < paragraphs.length; i++) {
    const wrapped = doc.splitTextToSize(paragraphs[i]!, wrapWidth) as string[];
    for (const line of wrapped) {
      items.push({ kind: "line", text: line, height: CLUE_LINE_HEIGHT });
    }
    if (i < paragraphs.length - 1) items.push({ kind: "gap", height: PARA_GAP });
  }

  let regions = pageOneRegions;
  let regionIdx = 0;
  let yInRegion = 0;
  let page = 1;
  let currentPage = 1;

  const advanceRegion = () => {
    regionIdx += 1;
    if (regionIdx >= regions.length) {
      page += 1;
      regions = continuationRegions(continuationCols);
      regionIdx = 0;
    }
    yInRegion = 0;
  };
  // Defensive: skip zero-height regions at the start (an unusually
  // tall grid can squeeze region 0 to nothing on a small layout).
  while (regions[regionIdx] && regions[regionIdx]!.h <= 0) advanceRegion();

  for (const it of items) {
    if (it.kind === "gap") {
      yInRegion += it.height;
      continue;
    }
    if (yInRegion + it.height > regions[regionIdx]!.h && yInRegion > 0) {
      advanceRegion();
      while (regions[regionIdx] && regions[regionIdx]!.h <= 0) advanceRegion();
    }
    while (currentPage < page) {
      doc.addPage();
      currentPage += 1;
    }
    const r = regions[regionIdx]!;
    doc.text(it.text, r.x, r.y + yInRegion + CLUE_SIZE);
    yInRegion += it.height;
  }
}
