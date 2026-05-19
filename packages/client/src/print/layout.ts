/**
 * Pure geometry for the print PDF. No drawing here — `computeLayout`
 * returns a description of the page-1 regions (title block, grid,
 * clue regions) and the continuation-column count for overflow pages.
 *
 * 12-unit horizontal grid. Small puzzles (width ≤ 16) use four
 * 3-unit columns: the grid spans cols 1+2 in the upper-left, and the
 * clues flow c1 → c2 (below the grid) → c3 → c4 (full-height). The
 * narrow columns let a daily 15×15 with typical clue counts fit on a
 * single page. Large puzzles (≥ 17) get an 8-4 split with three clue
 * regions. See docs/print-pdf-plan.md.
 */

export type Rect = { x: number; y: number; w: number; h: number };

export type LayoutSize = "small" | "large";

export type Layout = {
  size: LayoutSize;
  /** Page-1 title block (used to draw + reserve vertical space). */
  titleRect: Rect;
  /** Page-1 grid rectangle (the cells fit inside this; the grid is
   *  always square, so the actual drawn size is `min(w, h)`). */
  gridRect: Rect;
  /** Page-1 clue regions in flow order. */
  regions: Rect[];
  /** Continuation pages use this many equal-width columns spanning
   *  the full content height. */
  continuationCols: number;
};

// Page geometry — letter portrait, 0.25in margins (printer-safe
// floor; tighter than the typical 0.5in to win back enough room for a
// full daily-size 15x15 with non-cryptic clue counts).
export const PAGE = { w: 612, h: 792 };
export const MARGIN = 18;
export const CONTENT = { w: PAGE.w - 2 * MARGIN, h: PAGE.h - 2 * MARGIN };
export const UNIT = CONTENT.w / 12;

// Inter-region gaps.
export const COL_GAP = 12;
export const ROW_GAP = 12;
// Reserved height for the title block. The title is left-aligned at
// TITLE_SIZE pt; the two stacked right-aligned byline lines (author /
// copyright) sit beside it in a smaller font and fit inside the same
// vertical slot.
export const TITLE_BLOCK_H = 24;

const CONTENT_LEFT = MARGIN;
const CONTENT_TOP = MARGIN;
const CONTENT_RIGHT = MARGIN + CONTENT.w;
const CONTENT_BOTTOM = MARGIN + CONTENT.h;

/** Pick small vs large from puzzle width. ≤16 is small, ≥17 is large. */
export function pickSize(width: number): LayoutSize {
  return width <= 16 ? "small" : "large";
}

/** Compute square grid side length given a region rectangle and the
 *  puzzle's grid dimensions. The grid is N × N so width === height in
 *  cells; we fit the largest square that respects the rect. */
export function gridSide(rect: Rect): number {
  return Math.min(rect.w, rect.h);
}

/** Cell size in pt for an N-wide grid drawn into the given rect. */
export function cellSize(rect: Rect, gridWidth: number): number {
  return gridSide(rect) / gridWidth;
}

/** Compute the full layout description for a puzzle of the given
 *  width. Pure: no jsPDF references. */
export function computeLayout(puzzleWidth: number): Layout {
  const size = pickSize(puzzleWidth);

  const titleRect: Rect = {
    x: CONTENT_LEFT,
    y: CONTENT_TOP,
    w: CONTENT.w,
    h: TITLE_BLOCK_H,
  };

  // Content row sits below the title block.
  const rowTop = CONTENT_TOP + TITLE_BLOCK_H;
  const rowHeight = CONTENT.h - TITLE_BLOCK_H;
  // Right-side region (large region 3 / small region 2) is the full
  // remaining height; the below-grid row sits in the leftover space
  // under the grid.

  if (size === "small") {
    // Four 3-unit columns. Grid spans cols 1+2 (left 6 units); the
    // square side is bound by that width for our puzzle range.
    const gridRegionW = 6 * UNIT - COL_GAP / 2;
    const gridRectMax: Rect = { x: CONTENT_LEFT, y: rowTop, w: gridRegionW, h: rowHeight };
    const side = gridSide(gridRectMax);
    const gridRect: Rect = { x: CONTENT_LEFT, y: rowTop, w: side, h: side };

    const belowTop = rowTop + side + ROW_GAP;
    const belowH = Math.max(0, CONTENT_BOTTOM - belowTop);
    // Each of the 4 columns is 3 units wide, separated by COL_GAP.
    const colW = 3 * UNIT - COL_GAP / 2;
    // C1, C2: below the grid (left half). C3, C4: full-height (right half).
    const c1: Rect = { x: CONTENT_LEFT, y: belowTop, w: colW, h: belowH };
    const c2X = CONTENT_LEFT + 3 * UNIT + COL_GAP / 2;
    const c2: Rect = { x: c2X, y: belowTop, w: colW, h: belowH };
    const c3X = CONTENT_LEFT + 6 * UNIT + COL_GAP / 2;
    const c3: Rect = { x: c3X, y: rowTop, w: colW, h: rowHeight };
    const c4X = CONTENT_LEFT + 9 * UNIT + COL_GAP / 2;
    const c4: Rect = { x: c4X, y: rowTop, w: CONTENT_RIGHT - c4X, h: rowHeight };

    return {
      size,
      titleRect,
      gridRect,
      regions: [c1, c2, c3, c4],
      continuationCols: 4,
    };
  }

  // Large: grid 8 units wide. C1 + C2 in the lower-left under the grid
  // (4 + 4 units). C3 is the right 4 units, full height.
  const gridRegionW = 8 * UNIT - COL_GAP / 2;
  const gridRectMax: Rect = { x: CONTENT_LEFT, y: rowTop, w: gridRegionW, h: rowHeight };
  const side = gridSide(gridRectMax);
  const gridRect: Rect = { x: CONTENT_LEFT, y: rowTop, w: side, h: side };

  const belowTop = rowTop + side + ROW_GAP;
  const belowH = Math.max(0, CONTENT_BOTTOM - belowTop);
  // C1 + C2 split the grid's 8 units, with a small gap between them.
  const cWidth = 4 * UNIT - COL_GAP / 2;
  const c1: Rect = { x: CONTENT_LEFT, y: belowTop, w: cWidth, h: belowH };
  const c2X = CONTENT_LEFT + 4 * UNIT + COL_GAP / 2;
  const c2: Rect = { x: c2X, y: belowTop, w: cWidth, h: belowH };
  const c3X = CONTENT_LEFT + 8 * UNIT + COL_GAP / 2;
  const c3: Rect = { x: c3X, y: rowTop, w: CONTENT_RIGHT - c3X, h: rowHeight };

  return {
    size,
    titleRect,
    gridRect,
    regions: [c1, c2, c3],
    continuationCols: 3,
  };
}

/** Continuation-page columns: equal-width slices of the full content
 *  rectangle. Used when clues overflow page 1. */
export function continuationRegions(cols: number): Rect[] {
  const totalGap = COL_GAP * (cols - 1);
  const colW = (CONTENT.w - totalGap) / cols;
  const out: Rect[] = [];
  for (let i = 0; i < cols; i++) {
    out.push({
      x: CONTENT_LEFT + i * (colW + COL_GAP),
      y: CONTENT_TOP,
      w: colW,
      h: CONTENT.h,
    });
  }
  return out;
}
