import { describe, expect, it } from "vitest";
import type { LaidOutItem } from "./clues";
import { buildItems, paginate } from "./clues";
import type { Rect } from "./layout";

function region(h: number): Rect {
  return { x: 0, y: 0, w: 100, h };
}

function heading(text: "ACROSS" | "DOWN", height: number): LaidOutItem {
  return { item: { kind: "heading", text }, lines: [text], height };
}

function clue(num: number, height: number): LaidOutItem {
  return {
    item: { kind: "clue", number: num, text: `clue ${num}` },
    lines: [`clue ${num}`],
    height,
  };
}

describe("buildItems", () => {
  it("emits ACROSS heading then across clues, then DOWN heading then down clues", () => {
    const items = buildItems({
      across: [
        { number: 1, text: "a" },
        { number: 2, text: "b" },
      ],
      down: [{ number: 1, text: "d" }],
    });
    expect(items.map((i) => (i.kind === "heading" ? i.text : i.number))).toEqual([
      "ACROSS",
      1,
      2,
      "DOWN",
      1,
    ]);
  });
  it("omits a section heading when that direction has no clues", () => {
    const items = buildItems({ across: [{ number: 1, text: "a" }], down: [] });
    expect(items.find((i) => i.kind === "heading" && i.text === "DOWN")).toBeUndefined();
  });
});

describe("paginate", () => {
  it("places all items on page 1 when they fit", () => {
    const items: LaidOutItem[] = [
      heading("ACROSS", 14),
      clue(1, 12),
      clue(2, 12),
    ];
    const placements = paginate(items, [region(100), region(100)], 2);
    expect(placements.every((p) => p.page === 1)).toBe(true);
    expect(placements.map((p) => p.region.h)).toEqual([100, 100, 100]);
  });

  it("flows from region 1 to region 2 when region 1 is full", () => {
    const items: LaidOutItem[] = [clue(1, 30), clue(2, 30), clue(3, 30)];
    const placements = paginate(items, [region(50), region(200)], 2);
    expect(placements[0]!.region.h).toBe(50);
    expect(placements[1]!.region.h).toBe(200);
    expect(placements[2]!.region.h).toBe(200);
  });

  it("advances to a continuation page when all page-1 regions are full", () => {
    const items: LaidOutItem[] = [clue(1, 30), clue(2, 30), clue(3, 30)];
    const placements = paginate(items, [region(40), region(40)], 2);
    expect(placements[0]!.page).toBe(1);
    expect(placements[1]!.page).toBe(1);
    expect(placements[2]!.page).toBe(2);
  });

  it("orphan rule: pushes a heading to the next region if its first clue doesn't fit alongside", () => {
    // Region 1 has room for one 20pt item, but the heading+first-clue
    // pair is 14 + 12 = 26 — so the heading should move to region 2.
    const items: LaidOutItem[] = [
      clue(1, 18), // fills part of region 1
      heading("DOWN", 14), // would fit alone, but next clue wouldn't
      clue(2, 12),
    ];
    const placements = paginate(items, [region(30), region(100)], 2);
    expect(placements[0]!.region.h).toBe(30); // first clue in region 1
    expect(placements[1]!.region.h).toBe(100); // heading bumped to region 2
    expect(placements[2]!.region.h).toBe(100); // its clue follows
  });
});
