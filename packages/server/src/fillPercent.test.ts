import { describe, expect, it } from "vitest";
import type { Cell, GridSnapshot } from "@crossplay/shared";
import { computeFillPercent } from "./fillPercent.js";

/** Tiny 2x2 grid: one block in corner, three fillable cells. Helpers
 *  below copy + tweak this so each case is one tight call site. */
function emptyGrid(): GridSnapshot {
  return {
    version: 0,
    cells: [
      [
        { kind: "cell", number: 1, fill: null },
        { kind: "cell", number: 2, fill: null },
      ],
      [
        { kind: "cell", number: 3, fill: null },
        { kind: "block" },
      ],
    ],
  };
}

function withFills(...fills: (string | null)[]): GridSnapshot {
  const g = emptyGrid();
  const flat: Cell[] = [];
  for (const row of g.cells) for (const c of row) flat.push(c);
  let i = 0;
  for (const c of flat) {
    if (c.kind === "cell") {
      c.fill = fills[i] ?? null;
      i++;
    }
  }
  return g;
}

describe("computeFillPercent", () => {
  it("returns null when the live snapshot equals the initial one (untouched → NEW)", () => {
    expect(computeFillPercent(emptyGrid(), emptyGrid())).toBeNull();
  });

  it("ignores version differences when deciding 'untouched'", () => {
    const a = emptyGrid();
    const b = emptyGrid();
    b.version = 42;
    expect(computeFillPercent(a, b)).toBeNull();
  });

  it("counts a single fill against total fillable cells (1/3 → 33%)", () => {
    expect(computeFillPercent(emptyGrid(), withFills("A", null, null))).toBe(33);
  });

  it("rounds down (2/3 → 66%, not 67%)", () => {
    expect(computeFillPercent(emptyGrid(), withFills("A", "B", null))).toBe(66);
  });

  it("returns 100 when every fillable cell has a non-empty fill", () => {
    expect(computeFillPercent(emptyGrid(), withFills("A", "B", "C"))).toBe(100);
  });

  it("counts author-prefilled letters when the player has also changed something", () => {
    // Initial has one author-prefilled cell; live has the same plus one player fill.
    const initial = withFills("X", null, null);
    const live = withFills("X", "Y", null);
    // 2 of 3 fillable cells have letters.
    expect(computeFillPercent(initial, live)).toBe(66);
  });

  it("treats a board with only author prefills (unchanged from initial) as NEW", () => {
    const initial = withFills("X", null, null);
    const live = withFills("X", null, null);
    expect(computeFillPercent(initial, live)).toBeNull();
  });

  it("rebus answers count as a single filled cell", () => {
    expect(computeFillPercent(emptyGrid(), withFills("MOTH", null, null))).toBe(33);
  });

  it("returns null on an all-blocks grid (no fillable cells)", () => {
    const grid: GridSnapshot = {
      version: 0,
      cells: [[{ kind: "block" }, { kind: "block" }]],
    };
    const live: GridSnapshot = {
      version: 1,
      cells: [[{ kind: "block" }, { kind: "block" }]],
    };
    expect(computeFillPercent(grid, live)).toBeNull();
  });

  it("treats empty-string fills as not filled (defensive — wire protocol uses null)", () => {
    // Live grid differs from initial (empty string vs null), so it isn't NEW;
    // empty fill itself doesn't count toward the numerator.
    expect(computeFillPercent(emptyGrid(), withFills("", null, null))).toBe(0);
  });
});
