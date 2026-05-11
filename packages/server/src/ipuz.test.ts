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

  it("omits the saved grid entirely when nothing is filled", () => {
    const puzBuf = readFileSync(SUNDAY_PUZ);
    const { state, solution } = parsePuzBuffer("sunday", puzBuf);
    const obj = JSON.parse(writeIpuz(state, solution));
    expect(obj.saved).toBeUndefined();
  });

  it("emits player fills as the ipuz `saved` grid", () => {
    const puzBuf = readFileSync(SUNDAY_PUZ);
    const { state, solution } = parsePuzBuffer("sunday", puzBuf);
    state.snapshot.cells[0]![0] = { kind: "cell", number: 1, fill: "Z" };
    const obj = JSON.parse(writeIpuz(state, solution));
    expect(Array.isArray(obj.saved)).toBe(true);
    expect(obj.saved[0][0]).toBe("Z");
    // Cells without a fill serialize as the empty marker (0), not a letter.
    expect(obj.saved[0][1]).toBe(0);
    // Solution still carries the original letter, untouched by the typed-in fill.
    expect(obj.solution[0][0]).toBe(solution[0]![0]);
  });

  it("round-trips player fills through write -> parse", () => {
    const puzBuf = readFileSync(SUNDAY_PUZ);
    const { state, solution } = parsePuzBuffer("sunday", puzBuf);
    // Type a few letters at known open cells.
    const edits: Array<[number, number, string]> = [];
    outer: for (let r = 0; r < state.meta.height; r++) {
      for (let c = 0; c < state.meta.width; c++) {
        const cell = state.snapshot.cells[r]![c]!;
        if (cell.kind === "cell") {
          state.snapshot.cells[r]![c] = { ...cell, fill: "Q" };
          edits.push([r, c, "Q"]);
          if (edits.length >= 3) break outer;
        }
      }
    }
    const json = writeIpuz(state, solution);
    const reparsed = parseIpuzBuffer("sunday", Buffer.from(json, "utf8"));
    for (const [r, c, letter] of edits) {
      const cell = reparsed.state.snapshot.cells[r]![c]!;
      expect(cell.kind).toBe("cell");
      if (cell.kind === "cell") expect(cell.fill).toBe(letter);
    }
  });

  it("uppercases lowercase fills on emit", () => {
    const puzBuf = readFileSync(SUNDAY_PUZ);
    const { state, solution } = parsePuzBuffer("sunday", puzBuf);
    state.snapshot.cells[0]![0] = { kind: "cell", number: 1, fill: "q" };
    const obj = JSON.parse(writeIpuz(state, solution));
    expect(obj.saved[0][0]).toBe("Q");
  });

  it("round-trips circled cells through write -> parse", () => {
    const obj = structuredClone(MINIMAL_IPUZ);
    (obj.puzzle[0] as unknown[])[0] = { cell: 1, style: { shapebg: "circle" } };
    const parsed = parseIpuzBuffer("x", ipuzOf(obj));
    const json = writeIpuz(parsed.state, parsed.solution);
    const written = JSON.parse(json);
    // Emitted shape: object form with the style preserved.
    expect(written.puzzle[0][0]).toEqual({ cell: 1, style: { shapebg: "circle" } });
    // Non-circled cells stay as plain numbers.
    expect(written.puzzle[0][1]).toBe(2);

    const reparsed = parseIpuzBuffer("x", Buffer.from(json, "utf8"));
    const cell = reparsed.state.snapshot.cells[0]![0]!;
    if (cell.kind === "cell") expect(cell.circled).toBe(true);
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

  it("accepts rebus solutions up to the cap", () => {
    const obj = structuredClone(MINIMAL_IPUZ);
    obj.solution[0]![0] = "block";
    const { solution } = parseIpuzBuffer("x", ipuzOf(obj));
    expect(solution[0]![0]).toBe("BLOCK");
  });

  it("rejects rebus solutions over the cap", () => {
    const obj = structuredClone(MINIMAL_IPUZ);
    obj.solution[0]![0] = "ABCDEFGHI"; // 9 > 8
    expectReject(obj, /rebus solutions over 8 characters/);
  });

  it("accepts circled cells (style.shapebg='circle') and sets circled:true", () => {
    const obj = structuredClone(MINIMAL_IPUZ);
    (obj.puzzle[0] as unknown[])[0] = { cell: 1, style: { shapebg: "circle" } };
    const { state } = parseIpuzBuffer("x", ipuzOf(obj));
    const cell = state.snapshot.cells[0]![0]!;
    expect(cell.kind).toBe("cell");
    if (cell.kind === "cell") {
      expect(cell.circled).toBe(true);
      expect(cell.number).toBe(1);
    }
    // Untouched cells stay unmarked.
    const other = state.snapshot.cells[0]![1]!;
    if (other.kind === "cell") expect(other.circled).toBeUndefined();
  });

  it("rejects unsupported shapebg values", () => {
    const obj = structuredClone(MINIMAL_IPUZ);
    (obj.puzzle[0] as unknown[])[0] = { cell: 1, style: { shapebg: "diamond" } };
    expectReject(obj, /shapebg.*not supported/);
  });

  it("rejects shaded cells (style.shading)", () => {
    const obj = structuredClone(MINIMAL_IPUZ);
    (obj.puzzle[0] as unknown[])[0] = { cell: 1, style: { shading: "lightgrey" } };
    expectReject(obj, /style\.shading is not supported/);
  });

  it("rejects barred grids (style.barred)", () => {
    const obj = structuredClone(MINIMAL_IPUZ);
    (obj.puzzle[0] as unknown[])[0] = { cell: 1, style: { barred: "T" } };
    expectReject(obj, /style\.barred is not supported/);
  });

  it("rejects unknown style keys (whitelist)", () => {
    const obj = structuredClone(MINIMAL_IPUZ);
    (obj.puzzle[0] as unknown[])[0] = { cell: 1, style: { somethingNew: "x" } };
    expectReject(obj, /style\.somethingNew is not supported/);
  });

  it("rejects named style references", () => {
    const obj = structuredClone(MINIMAL_IPUZ);
    (obj.puzzle[0] as unknown[])[0] = { cell: 1, style: "themeAccent" };
    expectReject(obj, /named style references/);
  });

  it("rejects unknown cell-object keys", () => {
    const obj = structuredClone(MINIMAL_IPUZ);
    (obj.puzzle[0] as unknown[])[0] = { cell: 1, marks: { TL: "x" } };
    expectReject(obj, /unsupported cell-object key 'marks'/);
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

  it("accepts rebus saved values up to the cap", () => {
    const obj = structuredClone(MINIMAL_IPUZ) as unknown as Record<string, unknown>;
    obj.saved = [
      ["heart", 0, 0],
      [0, 0, 0],
      [0, 0, 0],
    ];
    const { state } = parseIpuzBuffer("x", ipuzOf(obj));
    const cell = state.snapshot.cells[0]![0]!;
    expect(cell.kind).toBe("cell");
    if (cell.kind === "cell") expect(cell.fill).toBe("HEART");
  });

  it("rejects saved values over the cap", () => {
    const obj = structuredClone(MINIMAL_IPUZ) as unknown as Record<string, unknown>;
    obj.saved = [
      ["ABCDEFGHI", 0, 0],
      [0, 0, 0],
      [0, 0, 0],
    ];
    expectReject(obj, /saved values over 8 characters/);
  });

  it("rejects mismatched saved-grid shape", () => {
    const obj = structuredClone(MINIMAL_IPUZ) as unknown as Record<string, unknown>;
    obj.saved = [[0, 0, 0], [0, 0, 0]];
    expectReject(obj, /saved grid must have 3 rows/);
  });
});
