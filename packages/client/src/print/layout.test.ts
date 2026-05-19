import { describe, expect, it } from "vitest";
import {
  CONTENT,
  MARGIN,
  TITLE_BLOCK_H,
  UNIT,
  computeLayout,
  continuationRegions,
  pickSize,
} from "./layout";

describe("pickSize", () => {
  it("returns small for width ≤ 16", () => {
    expect(pickSize(5)).toBe("small");
    expect(pickSize(15)).toBe("small");
    expect(pickSize(16)).toBe("small");
  });
  it("returns large for width ≥ 17", () => {
    expect(pickSize(17)).toBe("large");
    expect(pickSize(21)).toBe("large");
  });
});

describe("computeLayout (small, 15x15)", () => {
  const layout = computeLayout(15);
  it("dispatches to small", () => {
    expect(layout.size).toBe("small");
  });
  it("has a title block at the top-left of the content area", () => {
    expect(layout.titleRect.x).toBe(MARGIN);
    expect(layout.titleRect.y).toBe(MARGIN);
    expect(layout.titleRect.w).toBe(CONTENT.w);
    expect(layout.titleRect.h).toBe(TITLE_BLOCK_H);
  });
  it("places the grid below the title in the left 6 units", () => {
    expect(layout.gridRect.x).toBe(MARGIN);
    expect(layout.gridRect.y).toBe(MARGIN + TITLE_BLOCK_H);
    // Square grid: width === height.
    expect(layout.gridRect.w).toBe(layout.gridRect.h);
    // Width should be ≤ 6 units.
    expect(layout.gridRect.w).toBeLessThanOrEqual(6 * UNIT);
  });
  it("produces four clue regions (c1, c2 below grid; c3, c4 full-height)", () => {
    expect(layout.regions).toHaveLength(4);
    const [c1, c2, c3, c4] = layout.regions;
    // c1, c2 share a top edge below the grid.
    expect(c1!.y).toBe(c2!.y);
    expect(c1!.y).toBe(layout.gridRect.y + layout.gridRect.h + 12); // ROW_GAP
    expect(c1!.x).toBe(MARGIN);
    expect(c2!.x).toBeGreaterThan(c1!.x + c1!.w - 1);
    // c3, c4 are full-height under the title block.
    expect(c3!.y).toBe(MARGIN + TITLE_BLOCK_H);
    expect(c4!.y).toBe(MARGIN + TITLE_BLOCK_H);
    expect(c3!.x).toBeGreaterThan(MARGIN + 6 * UNIT - 1);
    expect(c4!.x).toBeGreaterThan(c3!.x + c3!.w - 1);
    expect(c3!.h).toBe(CONTENT.h - TITLE_BLOCK_H);
    expect(c4!.h).toBe(CONTENT.h - TITLE_BLOCK_H);
  });
  it("sets continuationCols to 4", () => {
    expect(layout.continuationCols).toBe(4);
  });
});

describe("computeLayout (large, 21x21)", () => {
  const layout = computeLayout(21);
  it("dispatches to large", () => {
    expect(layout.size).toBe("large");
  });
  it("places a square grid in the left 8 units", () => {
    expect(layout.gridRect.w).toBe(layout.gridRect.h);
    expect(layout.gridRect.w).toBeLessThanOrEqual(8 * UNIT);
  });
  it("produces exactly three clue regions", () => {
    expect(layout.regions).toHaveLength(3);
  });
  it("regions C1/C2 sit below the grid; C3 spans the right 4 units", () => {
    const [c1, c2, c3] = layout.regions;
    expect(c1!.y).toBe(c2!.y);
    expect(c1!.y).toBe(layout.gridRect.y + layout.gridRect.h + 12);
    expect(c1!.x).toBe(MARGIN);
    expect(c2!.x).toBeGreaterThan(c1!.x + c1!.w - 1);
    expect(c3!.x).toBeGreaterThan(MARGIN + 8 * UNIT - 1);
    expect(c3!.y).toBe(MARGIN + TITLE_BLOCK_H);
  });
  it("sets continuationCols to 3", () => {
    expect(layout.continuationCols).toBe(3);
  });
});

describe("continuationRegions", () => {
  it("produces 2 equal-width full-height columns when asked for 2", () => {
    const cols = continuationRegions(2);
    expect(cols).toHaveLength(2);
    expect(cols[0]!.w).toBeCloseTo(cols[1]!.w);
    for (const c of cols) {
      expect(c.y).toBe(MARGIN);
      expect(c.h).toBe(CONTENT.h);
    }
  });
  it("produces 3 equal-width columns when asked for 3", () => {
    const cols = continuationRegions(3);
    expect(cols).toHaveLength(3);
    expect(cols[0]!.w).toBeCloseTo(cols[1]!.w);
    expect(cols[1]!.w).toBeCloseTo(cols[2]!.w);
  });
  it("respects the page margins on both sides", () => {
    const [first, , last] = continuationRegions(3);
    expect(first!.x).toBe(MARGIN);
    expect(last!.x + last!.w).toBeCloseTo(MARGIN + CONTENT.w);
  });
});
