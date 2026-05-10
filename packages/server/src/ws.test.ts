import { describe, expect, it } from "vitest";
import type { Cell, PuzzleState } from "@crossplay/shared";
import type { StoredPuzzle } from "./store.js";
import { applyCheck, applyClear, applyFill, applyReveal, parseMessage } from "./ws.js";

// Mini grid (solution shown):
//   A B # C D    block at (0,2)
//   E F G H I
//   # # J # #    only J open in row 2
function entry(): StoredPuzzle {
  const cells: Cell[][] = [
    [
      { kind: "cell", number: 1, fill: null },
      { kind: "cell", number: 2, fill: null },
      { kind: "block" },
      { kind: "cell", number: 3, fill: null },
      { kind: "cell", number: null, fill: null },
    ],
    [
      { kind: "cell", number: 4, fill: null },
      { kind: "cell", number: null, fill: null },
      { kind: "cell", number: 5, fill: null },
      { kind: "cell", number: null, fill: null },
      { kind: "cell", number: null, fill: null },
    ],
    [
      { kind: "block" },
      { kind: "block" },
      { kind: "cell", number: null, fill: null },
      { kind: "block" },
      { kind: "block" },
    ],
  ];
  const state: PuzzleState = {
    meta: {
      id: "test",
      title: "",
      author: "",
      note: "",
      width: 5,
      height: 3,
      clues: { across: [], down: [] },
    },
    snapshot: { version: 0, cells },
  };
  const solution = [
    ["A", "B", null, "C", "D"],
    ["E", "F", "G", "H", "I"],
    [null, null, "J", null, null],
  ];
  return { state, solution, sockets: new Set(), recentHellos: new Map() };
}

const fill = (row: number, col: number, letter: string | null) =>
  ({ type: "fill", row, col, letter, clientVersion: 0 }) as const;

describe("parseMessage", () => {
  it("parses a valid fill", () => {
    expect(parseMessage(JSON.stringify(fill(0, 1, "A")))).toEqual(fill(0, 1, "A"));
  });
  it("parses reveal letter", () => {
    expect(
      parseMessage(JSON.stringify({ type: "reveal", scope: "letter", row: 1, col: 2 })),
    ).toEqual({ type: "reveal", scope: "letter", row: 1, col: 2 });
  });
  it("parses reveal word with direction", () => {
    expect(
      parseMessage(JSON.stringify({ type: "reveal", scope: "word", row: 0, col: 0, dir: "across" })),
    ).toEqual({ type: "reveal", scope: "word", row: 0, col: 0, dir: "across" });
  });
  it("parses reveal puzzle without coordinates", () => {
    expect(parseMessage(JSON.stringify({ type: "reveal", scope: "puzzle" }))).toEqual({
      type: "reveal",
      scope: "puzzle",
    });
  });
  it("parses check letter", () => {
    expect(
      parseMessage(JSON.stringify({ type: "check", scope: "letter", row: 0, col: 0 })),
    ).toEqual({ type: "check", scope: "letter", row: 0, col: 0 });
  });
  it("rejects malformed JSON", () => {
    expect(parseMessage("not json")).toBeNull();
  });
  it("rejects unknown type", () => {
    expect(parseMessage(JSON.stringify({ type: "ping" }))).toBeNull();
  });
  it("rejects reveal/check with bad scope", () => {
    expect(parseMessage(JSON.stringify({ type: "reveal", scope: "everything" }))).toBeNull();
  });
  it("rejects reveal word missing direction", () => {
    expect(
      parseMessage(JSON.stringify({ type: "reveal", scope: "word", row: 0, col: 0 })),
    ).toBeNull();
  });
});

describe("applyFill", () => {
  it("accepts a valid letter and bumps version", () => {
    const e = entry();
    const change = applyFill(e, fill(0, 0, "A"));
    expect(change).not.toBeNull();
    expect(e.state.snapshot.version).toBe(1);
    expect((e.state.snapshot.cells[0]![0] as { fill: string | null }).fill).toBe("A");
  });
  it("uppercases lowercase letters", () => {
    const e = entry();
    const change = applyFill(e, fill(0, 0, "z"));
    expect((change!.cell as { fill: string | null }).fill).toBe("Z");
  });
  it("clears wrong but preserves revealed on edit", () => {
    const e = entry();
    const cell = e.state.snapshot.cells[0]![0] as Cell & { kind: "cell" };
    cell.wrong = true;
    cell.revealed = true;
    applyFill(e, fill(0, 0, "X"));
    expect(cell.wrong).toBeUndefined();
    expect(cell.revealed).toBe(true);
  });
  it("rejects out-of-bounds", () => {
    expect(applyFill(entry(), fill(-1, 0, "A"))).toBeNull();
    expect(applyFill(entry(), fill(0, 5, "A"))).toBeNull();
  });
  it("rejects block cells", () => {
    expect(applyFill(entry(), fill(0, 2, "A"))).toBeNull();
  });
  it("rejects multi-character letters", () => {
    expect(applyFill(entry(), fill(0, 0, "AB"))).toBeNull();
  });
});

describe("applyFill pencil", () => {
  it("sets pencil flag when fill carries pencil:true", () => {
    const e = entry();
    const change = applyFill(e, { type: "fill", row: 0, col: 0, letter: "Z", clientVersion: 0, pencil: true });
    expect(change).not.toBeNull();
    const cell = e.state.snapshot.cells[0]![0] as Cell & { kind: "cell" };
    expect(cell.pencil).toBe(true);
  });
  it("clears pencil flag when later fill omits pencil", () => {
    const e = entry();
    applyFill(e, { type: "fill", row: 0, col: 0, letter: "Z", clientVersion: 0, pencil: true });
    applyFill(e, { type: "fill", row: 0, col: 0, letter: "A", clientVersion: 0 });
    const cell = e.state.snapshot.cells[0]![0] as Cell & { kind: "cell" };
    expect(cell.pencil).toBeUndefined();
  });
  it("clears pencil flag when fill is null", () => {
    const e = entry();
    applyFill(e, { type: "fill", row: 0, col: 0, letter: "Z", clientVersion: 0, pencil: true });
    applyFill(e, { type: "fill", row: 0, col: 0, letter: null, clientVersion: 0, pencil: true });
    const cell = e.state.snapshot.cells[0]![0] as Cell & { kind: "cell" };
    expect(cell.pencil).toBeUndefined();
    expect(cell.fill).toBeNull();
  });
});

describe("applyCheck with pencil", () => {
  it("skips pencil cells (no wrong flag, no change)", () => {
    const e = entry();
    applyFill(e, { type: "fill", row: 0, col: 0, letter: "Z", clientVersion: 0, pencil: true });
    const changes = applyCheck(e, { type: "check", scope: "letter", row: 0, col: 0 });
    expect(changes).toHaveLength(0);
    const cell = e.state.snapshot.cells[0]![0] as Cell & { kind: "cell" };
    expect(cell.wrong).toBeUndefined();
  });
});

describe("applyReveal with pencil", () => {
  it("clears pencil flag when revealing", () => {
    const e = entry();
    applyFill(e, { type: "fill", row: 0, col: 0, letter: "Z", clientVersion: 0, pencil: true });
    applyReveal(e, { type: "reveal", scope: "letter", row: 0, col: 0 });
    const cell = e.state.snapshot.cells[0]![0] as Cell & { kind: "cell" };
    expect(cell.pencil).toBeUndefined();
    expect(cell.revealed).toBe(true);
    expect(cell.fill).toBe("A"); // matches solution from entry()
  });
});

describe("applyReveal", () => {
  it("reveals a single letter", () => {
    const e = entry();
    const changes = applyReveal(e, { type: "reveal", scope: "letter", row: 1, col: 2 });
    expect(changes).toHaveLength(1);
    const cell = e.state.snapshot.cells[1]![2] as Cell & { kind: "cell" };
    expect(cell.fill).toBe("G");
    expect(cell.revealed).toBe(true);
    expect(e.state.snapshot.version).toBe(1);
  });
  it("reveals a whole across word", () => {
    const e = entry();
    const changes = applyReveal(e, { type: "reveal", scope: "word", row: 1, col: 2, dir: "across" });
    expect(changes).toHaveLength(5);
    expect((e.state.snapshot.cells[1]![0] as { fill: string | null }).fill).toBe("E");
    expect((e.state.snapshot.cells[1]![4] as { fill: string | null }).fill).toBe("I");
  });
  it("reveals a whole down word", () => {
    const e = entry();
    const changes = applyReveal(e, { type: "reveal", scope: "word", row: 1, col: 2, dir: "down" });
    expect(changes).toHaveLength(2); // (0,2) is block, so word is (1,2)-(2,2)
    expect((e.state.snapshot.cells[1]![2] as { fill: string | null }).fill).toBe("G");
    expect((e.state.snapshot.cells[2]![2] as { fill: string | null }).fill).toBe("J");
  });
  it("reveals the whole puzzle", () => {
    const e = entry();
    const changes = applyReveal(e, { type: "reveal", scope: "puzzle" });
    // row 0: 4 open (col 2 is block), row 1: 5, row 2: 1 (only col 2) = 10
    expect(changes).toHaveLength(10);
    expect((e.state.snapshot.cells[2]![2] as { fill: string | null }).fill).toBe("J");
  });
  it("clears wrong flag when revealing", () => {
    const e = entry();
    const cell = e.state.snapshot.cells[0]![0] as Cell & { kind: "cell" };
    cell.fill = "Z";
    cell.wrong = true;
    applyReveal(e, { type: "reveal", scope: "letter", row: 0, col: 0 });
    expect(cell.fill).toBe("A");
    expect(cell.wrong).toBeUndefined();
    expect(cell.revealed).toBe(true);
  });
});

describe("applyClear", () => {
  it("clears all fills, wrong, and revealed flags", () => {
    const e = entry();
    const c00 = e.state.snapshot.cells[0]![0] as Cell & { kind: "cell" };
    const c11 = e.state.snapshot.cells[1]![1] as Cell & { kind: "cell" };
    c00.fill = "X";
    c00.wrong = true;
    c11.fill = "F";
    c11.revealed = true;
    const changes = applyClear(e);
    expect(changes).toHaveLength(2);
    expect(c00.fill).toBeNull();
    expect(c00.wrong).toBeUndefined();
    expect(c11.fill).toBeNull();
    expect(c11.revealed).toBeUndefined();
  });
  it("returns no changes on an already-empty board", () => {
    const e = entry();
    expect(applyClear(e)).toHaveLength(0);
    expect(e.state.snapshot.version).toBe(0);
  });
});

describe("parseMessage clear", () => {
  it("parses a clear message", () => {
    expect(parseMessage(JSON.stringify({ type: "clear" }))).toEqual({ type: "clear" });
  });
});

describe("parseMessage showNotes", () => {
  it("parses a showNotes message", () => {
    expect(parseMessage(JSON.stringify({ type: "showNotes" }))).toEqual({
      type: "showNotes",
    });
  });
});

describe("parseMessage hello", () => {
  it("parses a valid hello", () => {
    expect(
      parseMessage(JSON.stringify({ type: "hello", name: "Joel", color: "#1f77b4" })),
    ).toEqual({ type: "hello", name: "Joel", color: "#1f77b4" });
  });
  it("rejects bad color", () => {
    expect(
      parseMessage(JSON.stringify({ type: "hello", name: "Joel", color: "blue" })),
    ).toBeNull();
  });
  it("rejects empty name", () => {
    expect(
      parseMessage(JSON.stringify({ type: "hello", name: "", color: "#1f77b4" })),
    ).toBeNull();
  });
});

describe("parseMessage senderColor", () => {
  it("preserves valid senderColor on fill", () => {
    const m = parseMessage(
      JSON.stringify({ type: "fill", row: 0, col: 0, letter: "A", clientVersion: 0, senderColor: "#1f77b4" }),
    );
    expect(m).toMatchObject({ type: "fill", senderColor: "#1f77b4" });
  });
  it("drops bad senderColor on fill (without rejecting the message)", () => {
    const m = parseMessage(
      JSON.stringify({ type: "fill", row: 0, col: 0, letter: "A", clientVersion: 0, senderColor: "blue" }),
    );
    expect(m).toMatchObject({ type: "fill" });
    expect(m).not.toHaveProperty("senderColor");
  });
  it("preserves senderColor on reveal", () => {
    const m = parseMessage(
      JSON.stringify({ type: "reveal", scope: "letter", row: 0, col: 0, senderColor: "#2ca02c" }),
    );
    expect(m).toMatchObject({ type: "reveal", senderColor: "#2ca02c" });
  });
  it("does not attach senderColor to check (irrelevant for that op)", () => {
    const m = parseMessage(
      JSON.stringify({ type: "check", scope: "letter", row: 0, col: 0, senderColor: "#2ca02c" }),
    );
    expect(m).not.toHaveProperty("senderColor");
  });
});

describe("parseMessage chat", () => {
  const ok = { type: "chat", name: "Joel", color: "#1f77b4", text: "hi" };
  it("parses a valid chat", () => {
    expect(parseMessage(JSON.stringify(ok))).toEqual(ok);
  });
  it("trims text", () => {
    expect(parseMessage(JSON.stringify({ ...ok, text: "  hello  " }))).toEqual({
      ...ok,
      text: "hello",
    });
  });
  it("rejects empty text", () => {
    expect(parseMessage(JSON.stringify({ ...ok, text: "   " }))).toBeNull();
  });
  it("rejects too-long text", () => {
    expect(parseMessage(JSON.stringify({ ...ok, text: "x".repeat(501) }))).toBeNull();
  });
  it("rejects bad color", () => {
    expect(parseMessage(JSON.stringify({ ...ok, color: "red" }))).toBeNull();
  });
  it("rejects empty name", () => {
    expect(parseMessage(JSON.stringify({ ...ok, name: "" }))).toBeNull();
  });
});

describe("applyCheck", () => {
  it("marks wrong cells with the wrong flag", () => {
    const e = entry();
    (e.state.snapshot.cells[0]![0] as { fill: string | null }).fill = "X";
    const changes = applyCheck(e, { type: "check", scope: "letter", row: 0, col: 0 });
    expect(changes).toHaveLength(1);
    expect((e.state.snapshot.cells[0]![0] as { wrong?: boolean }).wrong).toBe(true);
  });
  it("does not mark correct cells", () => {
    const e = entry();
    (e.state.snapshot.cells[0]![0] as { fill: string | null }).fill = "A";
    const changes = applyCheck(e, { type: "check", scope: "letter", row: 0, col: 0 });
    expect(changes).toHaveLength(0);
  });
  it("skips empty cells", () => {
    const e = entry();
    const changes = applyCheck(e, { type: "check", scope: "letter", row: 0, col: 0 });
    expect(changes).toHaveLength(0);
  });
  it("clears wrong on a previously-wrong cell that's now right", () => {
    const e = entry();
    const cell = e.state.snapshot.cells[0]![0] as Cell & { kind: "cell" };
    cell.fill = "A";
    cell.wrong = true;
    const changes = applyCheck(e, { type: "check", scope: "letter", row: 0, col: 0 });
    expect(changes).toHaveLength(1);
    expect(cell.wrong).toBeUndefined();
  });
  it("checks an entire word", () => {
    const e = entry();
    (e.state.snapshot.cells[1]![0] as { fill: string | null }).fill = "X";
    (e.state.snapshot.cells[1]![1] as { fill: string | null }).fill = "F"; // correct
    (e.state.snapshot.cells[1]![2] as { fill: string | null }).fill = "Z";
    const changes = applyCheck(e, { type: "check", scope: "word", row: 1, col: 0, dir: "across" });
    expect(changes.map((c) => `${c.row}:${c.col}`)).toEqual(["1:0", "1:2"]);
  });
  it("checks the whole puzzle", () => {
    const e = entry();
    (e.state.snapshot.cells[0]![0] as { fill: string | null }).fill = "X";
    (e.state.snapshot.cells[2]![2] as { fill: string | null }).fill = "J"; // correct
    const changes = applyCheck(e, { type: "check", scope: "puzzle" });
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ row: 0, col: 0 });
  });
});
