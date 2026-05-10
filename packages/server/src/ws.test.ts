import { describe, expect, it } from "vitest";
import type { Cell, PuzzleState } from "@crossplay/shared";
import type { StoredPuzzle } from "./store.js";
import { applyFill, parseMessage } from "./ws.js";

function entry(): StoredPuzzle {
  const cells: Cell[][] = [
    [
      { kind: "cell", number: 1, fill: null },
      { kind: "cell", number: 2, fill: null },
      { kind: "block" },
    ],
    [
      { kind: "cell", number: 3, fill: null },
      { kind: "cell", number: null, fill: "X" },
      { kind: "cell", number: null, fill: null },
    ],
  ];
  const state: PuzzleState = {
    meta: {
      id: "test",
      title: "",
      author: "",
      width: 3,
      height: 2,
      clues: { across: [], down: [] },
    },
    snapshot: { version: 0, cells },
  };
  return { state, solution: [], sockets: new Set() };
}

const fill = (row: number, col: number, letter: string | null) =>
  ({ type: "fill", row, col, letter, clientVersion: 0 }) as const;

describe("parseMessage", () => {
  it("parses a valid fill", () => {
    expect(parseMessage(JSON.stringify(fill(0, 1, "A")))).toEqual(fill(0, 1, "A"));
  });
  it("parses null letter", () => {
    expect(parseMessage(JSON.stringify(fill(0, 1, null)))).toEqual(fill(0, 1, null));
  });
  it("rejects malformed JSON", () => {
    expect(parseMessage("not json")).toBeNull();
  });
  it("rejects unknown type", () => {
    expect(parseMessage(JSON.stringify({ type: "ping" }))).toBeNull();
  });
  it("rejects missing fields", () => {
    expect(parseMessage(JSON.stringify({ type: "fill", row: 0 }))).toBeNull();
  });
  it("rejects wrong types", () => {
    expect(parseMessage(JSON.stringify({ type: "fill", row: "0", col: 0, letter: "A", clientVersion: 0 }))).toBeNull();
  });
});

describe("applyFill", () => {
  it("accepts a valid letter and bumps version", () => {
    const e = entry();
    const result = applyFill(e, fill(0, 0, "A"));
    expect(result).toEqual({ row: 0, col: 0, letter: "A", version: 1 });
    expect(e.state.snapshot.version).toBe(1);
    expect((e.state.snapshot.cells[0]![0] as { fill: string | null }).fill).toBe("A");
  });
  it("uppercases lowercase letters", () => {
    const e = entry();
    expect(applyFill(e, fill(0, 0, "z"))?.letter).toBe("Z");
  });
  it("accepts null to clear", () => {
    const e = entry();
    const result = applyFill(e, fill(1, 1, null));
    expect(result?.letter).toBeNull();
    expect((e.state.snapshot.cells[1]![1] as { fill: string | null }).fill).toBeNull();
  });
  it("rejects out-of-bounds row", () => {
    expect(applyFill(entry(), fill(-1, 0, "A"))).toBeNull();
    expect(applyFill(entry(), fill(2, 0, "A"))).toBeNull();
  });
  it("rejects out-of-bounds col", () => {
    expect(applyFill(entry(), fill(0, -1, "A"))).toBeNull();
    expect(applyFill(entry(), fill(0, 3, "A"))).toBeNull();
  });
  it("rejects block cells", () => {
    expect(applyFill(entry(), fill(0, 2, "A"))).toBeNull();
  });
  it("rejects multi-character letters", () => {
    expect(applyFill(entry(), fill(0, 0, "AB"))).toBeNull();
  });
  it("rejects non-letter input", () => {
    expect(applyFill(entry(), fill(0, 0, "1"))).toBeNull();
  });
  it("does not bump version on rejection", () => {
    const e = entry();
    applyFill(e, fill(0, 2, "A"));
    expect(e.state.snapshot.version).toBe(0);
  });
});
