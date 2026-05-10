import { describe, expect, it } from "vitest";
import type { Cell } from "@crossplay/shared";
import {
  activeClueNumber,
  advanceAfterFill,
  clueStarts,
  findWordStart,
  firstOpenCell,
  jumpClue,
  moveCursor,
  retreatForBackspace,
  wordCells,
} from "./cursor";

function grid(rows: string[]): Cell[][] {
  let n = 0;
  const raw = rows.map((row) => Array.from(row));
  const isBlock = (r: number, c: number) =>
    r < 0 || c < 0 || r >= raw.length || c >= raw[0]!.length || raw[r]![c] === "#";
  return raw.map((row, r) =>
    row.map((ch, c): Cell => {
      if (ch === "#") return { kind: "block" };
      const startsAcross = isBlock(r, c - 1) && !isBlock(r, c + 1);
      const startsDown = isBlock(r - 1, c) && !isBlock(r + 1, c);
      const number = startsAcross || startsDown ? ++n : null;
      const fill = /[A-Z]/.test(ch) ? ch : null;
      return { kind: "cell", number, fill };
    }),
  );
}

describe("firstOpenCell", () => {
  it("skips leading blocks", () => {
    const g = grid(["##.", ".##"]);
    expect(firstOpenCell(g)).toEqual({ row: 0, col: 2 });
  });
  it("returns null on all-block", () => {
    expect(firstOpenCell(grid(["##", "##"]))).toBeNull();
  });
});

describe("findWordStart", () => {
  const g = grid(["...", "...", "..."]);
  it("walks to left edge for across", () => {
    expect(findWordStart(g, 1, 2, "across")).toEqual({ row: 1, col: 0 });
  });
  it("walks to top edge for down", () => {
    expect(findWordStart(g, 2, 1, "down")).toEqual({ row: 0, col: 1 });
  });
  it("stops at block", () => {
    const g2 = grid([".#.", "...", "..."]);
    expect(findWordStart(g2, 0, 2, "across")).toEqual({ row: 0, col: 2 });
    const g3 = grid(["...", "#..", "..."]);
    expect(findWordStart(g3, 2, 0, "down")).toEqual({ row: 2, col: 0 });
  });
});

describe("wordCells", () => {
  it("returns full across word", () => {
    const g = grid(["...", "###", "###"]);
    expect(wordCells(g, 0, 1, "across")).toEqual([
      { row: 0, col: 0 },
      { row: 0, col: 1 },
      { row: 0, col: 2 },
    ]);
  });
  it("returns full down word", () => {
    const g = grid([".##", ".##", ".##"]);
    expect(wordCells(g, 1, 0, "down")).toEqual([
      { row: 0, col: 0 },
      { row: 1, col: 0 },
      { row: 2, col: 0 },
    ]);
  });
  it("returns empty for block start", () => {
    const g = grid(["#.", ".."]);
    expect(wordCells(g, 0, 0, "across")).toEqual([]);
  });
});

describe("activeClueNumber", () => {
  it("returns the number at the word start", () => {
    const g = grid(["...", "#..", "..."]);
    expect(activeClueNumber(g, 2, 1, "down")).toBe(2);
    expect(activeClueNumber(g, 1, 2, "across")).toBe(4);
  });
});

describe("moveCursor", () => {
  it("perpendicular arrow only changes direction, no move", () => {
    const g = grid(["...", "..."]);
    expect(moveCursor(g, { row: 0, col: 0, dir: "down" }, "ArrowRight")).toEqual({
      row: 0,
      col: 0,
      dir: "across",
    });
    expect(moveCursor(g, { row: 0, col: 0, dir: "across" }, "ArrowDown")).toEqual({
      row: 0,
      col: 0,
      dir: "down",
    });
  });
  it("moves when arrow matches current facing", () => {
    const g = grid(["...", "..."]);
    expect(moveCursor(g, { row: 0, col: 0, dir: "across" }, "ArrowRight")).toEqual({
      row: 0,
      col: 1,
      dir: "across",
    });
    expect(moveCursor(g, { row: 0, col: 0, dir: "down" }, "ArrowDown")).toEqual({
      row: 1,
      col: 0,
      dir: "down",
    });
  });
  it("skips over blocks", () => {
    const g = grid([".#.", "..."]);
    expect(moveCursor(g, { row: 0, col: 0, dir: "across" }, "ArrowRight")).toEqual({
      row: 0,
      col: 2,
      dir: "across",
    });
  });
  it("stays put at edge", () => {
    const g = grid(["..."]);
    expect(moveCursor(g, { row: 0, col: 2, dir: "across" }, "ArrowRight")).toEqual({
      row: 0,
      col: 2,
      dir: "across",
    });
  });
  it("does not move into a wall of blocks", () => {
    const g = grid(["..#", "###"]);
    expect(moveCursor(g, { row: 0, col: 1, dir: "across" }, "ArrowRight")).toEqual({
      row: 0,
      col: 1,
      dir: "across",
    });
  });
});

describe("advanceAfterFill", () => {
  it("moves to the next cell across, regardless of fill", () => {
    const g = grid(["AB."]);
    expect(advanceAfterFill(g, { row: 0, col: 0, dir: "across" })).toEqual({
      row: 0,
      col: 1,
      dir: "across",
    });
  });
  it("jumps over blocks to next word", () => {
    const g = grid([".#."]);
    expect(advanceAfterFill(g, { row: 0, col: 0, dir: "across" })).toEqual({
      row: 0,
      col: 2,
      dir: "across",
    });
  });
  it("stays put at the grid edge", () => {
    const g = grid(["AB"]);
    expect(advanceAfterFill(g, { row: 0, col: 1, dir: "across" })).toEqual({
      row: 0,
      col: 1,
      dir: "across",
    });
  });
  it("works downward", () => {
    const g = grid([".", ".", "."]);
    expect(advanceAfterFill(g, { row: 0, col: 0, dir: "down" })).toEqual({
      row: 1,
      col: 0,
      dir: "down",
    });
  });
});

describe("clueStarts", () => {
  it("emits across then down, in numeric reading order within each", () => {
    // grid "...", "#..", "..."
    // (0,0) starts across only — block below means no down word
    // (0,1) starts down only; (0,2) starts down only
    // (1,1) starts across only; (2,0) starts across only
    const g = grid(["...", "#..", "..."]);
    const summary = clueStarts(g).map((s) => `${s.dir[0]}${s.number}`);
    expect(summary.filter((s) => s.startsWith("a"))).toEqual(["a1", "a4", "a5"]);
    expect(summary.filter((s) => s.startsWith("d"))).toEqual(["d2", "d3"]);
    expect(summary.indexOf("a5")).toBeLessThan(summary.indexOf("d2"));
  });
});

describe("jumpClue", () => {
  const g = grid(["...", "#..", "..."]);
  it("Tab moves to next clue in order", () => {
    // a1 (0,0) → a4 (1,1)
    const next = jumpClue(g, { row: 0, col: 0, dir: "across" }, 1);
    expect(next).toEqual({ row: 1, col: 1, dir: "across" });
  });
  it("wraps from last across to first down", () => {
    // a5 (2,0) → d2 (0,1)
    const next = jumpClue(g, { row: 2, col: 0, dir: "across" }, 1);
    expect(next).toEqual({ row: 0, col: 1, dir: "down" });
  });
  it("wraps from first to last with delta=-1", () => {
    // a1 (0,0) backward → last entry, which is d3 (0,2)
    const prev = jumpClue(g, { row: 0, col: 0, dir: "across" }, -1);
    expect(prev).toEqual({ row: 0, col: 2, dir: "down" });
  });
});

describe("retreatForBackspace", () => {
  it("moves back one cell across", () => {
    const g = grid(["AB."]);
    expect(retreatForBackspace(g, { row: 0, col: 2, dir: "across" })).toEqual({
      row: 0,
      col: 1,
      dir: "across",
    });
  });
  it("skips blocks going back", () => {
    const g = grid([".#."]);
    expect(retreatForBackspace(g, { row: 0, col: 2, dir: "across" })).toEqual({
      row: 0,
      col: 0,
      dir: "across",
    });
  });
  it("stays put at left edge", () => {
    const g = grid(["..."]);
    expect(retreatForBackspace(g, { row: 0, col: 0, dir: "across" })).toEqual({
      row: 0,
      col: 0,
      dir: "across",
    });
  });
});
