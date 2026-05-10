import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { IpuzUnsupportedError, parseIpuzBuffer, writeIpuz } from "./ipuz.js";
import { parsePuzBuffer } from "./puzzle.js";

const FIXTURE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");
const SUNDAY_PUZ = resolve(FIXTURE_DIR, "sunday-sample.puz");
const SUNDAY_IPUZ = resolve(FIXTURE_DIR, "sunday-sample.ipuz");

function ipuzOf(obj: unknown): Buffer {
  return Buffer.from(JSON.stringify(obj), "utf8");
}

const MINIMAL_IPUZ = {
  version: "http://ipuz.org/v2",
  kind: ["http://ipuz.org/crossword#1"],
  dimensions: { width: 3, height: 3 },
  puzzle: [
    [1, 2, 3],
    [4, 0, 0],
    ["#", 5, 0],
  ],
  solution: [
    ["A", "B", "C"],
    ["D", "E", "F"],
    ["#", "G", "H"],
  ],
  clues: {
    Across: [
      [1, "first"],
      [4, "fourth"],
      [5, "fifth"],
    ],
    Down: [
      [1, "down 1"],
      [2, "down 2"],
      [3, "down 3"],
    ],
  },
};

describe("parseIpuzBuffer (minimal happy path)", () => {
  const { state, solution } = parseIpuzBuffer("toy", ipuzOf(MINIMAL_IPUZ));

  it("uses the provided id", () => {
    expect(state.meta.id).toBe("toy");
  });

  it("preserves dimensions and clue counts", () => {
    expect(state.meta.width).toBe(3);
    expect(state.meta.height).toBe(3);
    expect(state.meta.clues.across).toHaveLength(3);
    expect(state.meta.clues.down).toHaveLength(3);
  });

  it("renders blocks where the puzzle uses '#'", () => {
    expect(state.snapshot.cells[2]![0]).toEqual({ kind: "block" });
  });

  it("preserves explicit cell numbers from the puzzle grid", () => {
    expect(state.snapshot.cells[0]![0]).toMatchObject({ kind: "cell", number: 1 });
    expect(state.snapshot.cells[1]![1]).toMatchObject({ kind: "cell", number: null });
  });

  it("solution is uppercased and aligned with the puzzle grid", () => {
    expect(solution[0]).toEqual(["A", "B", "C"]);
    expect(solution[2]![0]).toBeNull();
  });

  it("starts at version 0 with no fills", () => {
    expect(state.snapshot.version).toBe(0);
    const fills = state.snapshot.cells.flat().filter((c) => c.kind === "cell" && c.fill != null);
    expect(fills).toHaveLength(0);
  });
});

describe("parseIpuzBuffer (fixture round-trip)", () => {
  it("parses the converted Sunday fixture and matches the .puz parse", () => {
    const ipuzBuf = readFileSync(SUNDAY_IPUZ);
    const puzBuf = readFileSync(SUNDAY_PUZ);
    const fromIpuz = parseIpuzBuffer("sunday", ipuzBuf);
    const fromPuz = parsePuzBuffer("sunday", puzBuf);

    expect(fromIpuz.state.meta.width).toBe(fromPuz.state.meta.width);
    expect(fromIpuz.state.meta.height).toBe(fromPuz.state.meta.height);
    expect(fromIpuz.state.meta.title).toBe(fromPuz.state.meta.title);
    expect(fromIpuz.state.meta.author).toBe(fromPuz.state.meta.author);
    expect(fromIpuz.state.meta.copyright).toBe(fromPuz.state.meta.copyright);
    expect(fromIpuz.state.meta.note).toBe(fromPuz.state.meta.note);
    expect(fromIpuz.state.meta.clues).toEqual(fromPuz.state.meta.clues);
    expect(fromIpuz.state.snapshot.cells).toEqual(fromPuz.state.snapshot.cells);
    expect(fromIpuz.solution).toEqual(fromPuz.solution);
  });
});

describe("writeIpuz", () => {
  it("round-trips through parseIpuzBuffer", () => {
    const puzBuf = readFileSync(SUNDAY_PUZ);
    const original = parsePuzBuffer("sunday", puzBuf);
    const json = writeIpuz(original.state, original.solution);
    const reparsed = parseIpuzBuffer("sunday", Buffer.from(json, "utf8"));

    expect(reparsed.state.meta).toEqual(original.state.meta);
    expect(reparsed.state.snapshot.cells).toEqual(original.state.snapshot.cells);
    expect(reparsed.solution).toEqual(original.solution);
  });

  it("does not emit player fills", () => {
    const puzBuf = readFileSync(SUNDAY_PUZ);
    const { state, solution } = parsePuzBuffer("sunday", puzBuf);
    const originalSolution = solution[0]![0];
    state.snapshot.cells[0]![0] = { kind: "cell", number: 1, fill: "Z" };
    const obj = JSON.parse(writeIpuz(state, solution));
    // No `fill` key anywhere in the emitted ipuz puzzle grid.
    expect(JSON.stringify(obj.puzzle)).not.toMatch(/"fill"/);
    // The cell we mutated still serializes its solution letter, not the typed-in fill.
    expect(obj.solution[0][0]).toBe(originalSolution);
  });

  it("emits standard ipuz crossword headers", () => {
    const puzBuf = readFileSync(SUNDAY_PUZ);
    const { state, solution } = parsePuzBuffer("sunday", puzBuf);
    const obj = JSON.parse(writeIpuz(state, solution));
    expect(obj.version).toBe("http://ipuz.org/v2");
    expect(obj.kind).toEqual(["http://ipuz.org/crossword#1"]);
    expect(obj.dimensions).toEqual({ width: state.meta.width, height: state.meta.height });
    expect(obj.clues.Across[0]).toEqual([state.meta.clues.across[0]!.number, state.meta.clues.across[0]!.text]);
  });
});

describe("parseIpuzBuffer (rejections)", () => {
  function expectReject(obj: unknown, match: RegExp | string) {
    expect(() => parseIpuzBuffer("x", ipuzOf(obj))).toThrow(IpuzUnsupportedError);
    expect(() => parseIpuzBuffer("x", ipuzOf(obj))).toThrow(match);
  }

  it("rejects invalid JSON", () => {
    expect(() => parseIpuzBuffer("x", Buffer.from("not json"))).toThrow(IpuzUnsupportedError);
  });

  it("rejects non-crossword kinds", () => {
    expectReject({ ...MINIMAL_IPUZ, kind: ["http://ipuz.org/sudoku#1"] }, /unsupported puzzle kind/);
  });

  it("rejects missing dimensions", () => {
    const { dimensions: _, ...rest } = MINIMAL_IPUZ;
    expectReject(rest, /missing `dimensions`/);
  });

  it("rejects rebus solutions", () => {
    const obj = structuredClone(MINIMAL_IPUZ);
    obj.solution[0]![0] = "AB";
    expectReject(obj, /rebus solutions are not supported/);
  });

  it("rejects circled cells (style.shapebg)", () => {
    const obj = structuredClone(MINIMAL_IPUZ);
    (obj.puzzle[0] as unknown[])[0] = { cell: 1, style: { shapebg: "circle" } };
    expectReject(obj, /shapebg/);
  });

  it("rejects shaded cells", () => {
    const obj = structuredClone(MINIMAL_IPUZ);
    (obj.puzzle[0] as unknown[])[0] = { cell: 1, style: { shading: "lightgrey" } };
    expectReject(obj, /shaded cells/);
  });

  it("rejects barred grids", () => {
    const obj = structuredClone(MINIMAL_IPUZ);
    (obj.puzzle[0] as unknown[])[0] = { cell: 1, style: { barred: "T" } };
    expectReject(obj, /barred grids/);
  });

  it("rejects null cells (irregular grids)", () => {
    const obj = structuredClone(MINIMAL_IPUZ);
    obj.puzzle[2]![0] = null as unknown as string;
    expectReject(obj, /null cells/);
  });

  it("rejects mismatched solution shape", () => {
    const obj = structuredClone(MINIMAL_IPUZ);
    obj.solution[0] = ["A", "B"];
    expectReject(obj, /solution row 0 must have 3 cells/);
  });

  it("rejects pre-filled cell values", () => {
    const obj = structuredClone(MINIMAL_IPUZ);
    (obj.puzzle[0] as unknown[])[0] = { cell: 1, value: "A" };
    expectReject(obj, /pre-filled cell values/);
  });
});
