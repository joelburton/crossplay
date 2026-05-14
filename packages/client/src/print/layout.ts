/**
 * Pure geometry for the print PDF. No drawing here — `computeLayout`
 * returns a description of the page-1 regions (title block, grid,
 * clue regions) and the continuation-column count for overflow pages.
 *
 * 12-unit horizontal grid. Small puzzles (width ≤ 16) get a 6-6 split
 * — grid in the upper-left, two clue regions. Large puzzles (≥ 17)
 * get an 8-4 split with three clue regions. See docs/print-pdf-plan.md.
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
    // Grid: left 6 units, square (limited by 6-unit width or remaining
    // height — for our puzzle range the width is the binding constraint).
    const gridRegionW = 6 * UNIT - COL_GAP / 2;
    const gridRectMax: Rect = { x: CONTENT_LEFT, y: rowTop, w: gridRegionW, h: rowHeight };
    const side = gridSide(gridRectMax);
    const gridRect: Rect = { x: CONTENT_LEFT, y: rowTop, w: side, h: side };

    // Region 1: below the grid, 6 units wide. Region 2: right 6 units,
    // full height under the title.
    const region1Top = rowTop + side + ROW_GAP;
    const region1H = CONTENT_BOTTOM - region1Top;
    const region1: Rect = {
      x: CONTENT_LEFT,
      y: region1Top,
      w: gridRegionW,
      h: Math.max(0, region1H),
    };
    const region2X = CONTENT_LEFT + 6 * UNIT + COL_GAP / 2;
    const region2: Rect = {
      x: region2X,
      y: rowTop,
      w: CONTENT_RIGHT - region2X,
      h: rowHeight,
    };

    return {
      size,
      titleRect,
      gridRect,
      regions: [region1, region2],
      continuationCols: 2,
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
