import { describe, expect, it } from "vitest";
import type { Cell } from "@crossplay/shared";
import type { StoredBoard } from "./store.js";
import { resolveClueForExplain, sliceNoteForClue } from "./clueAnswer.js";

/** Build a minimal StoredBoard around a 3x3 grid:
 *
 *     1 . .
 *     2 # .
 *     . . .
 *
 *   1 Across: 3 cells (CAT)
 *   1 Down:   3 cells (C ? ?)
 *   ...we only exercise the 1-Across path; the down clue is here to
 *   prove findClueStart picks the correct numbered cell.
 *
 *   The puzzle has a setter's note so the route gates we care about
 *   (no-note path lives in http.test.ts) don't collide here.
 */
function makeBoard(
  fill: (string | null)[],
  markRight?: ("break" | "hyphen" | undefined)[],
): StoredBoard {
  const blank = (): Cell => ({ kind: "cell", number: null, fill: null });
  const row0: Cell[] = [
    { kind: "cell", number: 1, fill: fill[0] ?? null, markRight: markRight?.[0] },
    { kind: "cell", number: null, fill: fill[1] ?? null, markRight: markRight?.[1] },
    { kind: "cell", number: null, fill: fill[2] ?? null, markRight: markRight?.[2] },
  ];
  const row1: Cell[] = [
    { kind: "cell", number: 2, fill: null },
    { kind: "block" },
    { kind: "cell", number: null, fill: null },
  ];
  const row2: Cell[] = [blank(), blank(), blank()];
  const cells: Cell[][] = [row0, row1, row2];

  const solution: (string[] | null)[][] = [
    [["C"], ["A"], ["T"]],
    [["X"], null, ["Y"]],
    [["Z"], ["Z"], ["Z"]],
  ];

  return {
    id: "test",
    state: {
      meta: {
        id: "test",
        title: "t",
        author: "",
        copyright: "",
        note: "1 anag.",
        width: 3,
        height: 3,
        clues: {
          across: [{ number: 1, text: "Furry pet" }],
          down: [{ number: 1, text: "" }, { number: 2, text: "" }],
        },
      },
      snapshot: { version: 1, cells },
    },
    initialSnapshot: { version: 1, cells },
    solution,
    chat: [],
    sockets: new Set(),
    recentHellos: new Map(),
    cursorBySocket: new Map(),
    feedbackCounter: 0,
    solved: false,
    scratchpadText: "",
    scratchpadLock: null,
    lastScratchpadEditAt: 0,
    dirty: false,
  };
}

describe("resolveClueForExplain", () => {
  it("returns the canonical answer and complete-correct fill", () => {
    const entry = makeBoard(["C", "A", "T"]);
    const res = resolveClueForExplain(entry, 1, "across");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.context.clueText).toBe("Furry pet");
    expect(res.context.answer).toBe("CAT");
    expect(res.context.playerFill).toBe("CAT");
    expect(res.context.allFilled).toBe(true);
    expect(res.context.fillCorrect).toBe(true);
    expect(res.context.enumeration).toBe("(3)");
  });

  it("flags an incomplete fill", () => {
    const entry = makeBoard(["C", null, "T"]);
    const res = resolveClueForExplain(entry, 1, "across");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.context.allFilled).toBe(false);
    expect(res.context.fillCorrect).toBe(false);
  });

  it("flags a wrong fill that is fully filled", () => {
    const entry = makeBoard(["C", "A", "B"]);
    const res = resolveClueForExplain(entry, 1, "across");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.context.allFilled).toBe(true);
    expect(res.context.fillCorrect).toBe(false);
  });

  it("derives enumeration from markRight (break and hyphen)", () => {
    const e1 = makeBoard(["C", "A", "T"], ["break", undefined, undefined]);
    const r1 = resolveClueForExplain(e1, 1, "across");
    expect(r1.ok && r1.context.enumeration).toBe("(1,2)");

    const e2 = makeBoard(["C", "A", "T"], ["hyphen", undefined, undefined]);
    const r2 = resolveClueForExplain(e2, 1, "across");
    expect(r2.ok && r2.context.enumeration).toBe("(1-2)");
  });

  it("returns clue_not_found for an unknown clue number", () => {
    const entry = makeBoard(["C", "A", "T"]);
    const res = resolveClueForExplain(entry, 99, "across");
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe("clue_not_found");
  });
});

describe("sliceNoteForClue", () => {
  const note = `ACROSS
1 anag. 2 two meanings. 5 hidden word in "of the".
DOWN
1 charade. 3 reversal of EVIL. 10 &lit.`;

  it("returns just the entry for an across clue", () => {
    expect(sliceNoteForClue(note, 1, "across")).toBe("1 anag.");
    expect(sliceNoteForClue(note, 2, "across")).toBe("2 two meanings.");
    expect(sliceNoteForClue(note, 5, "across")).toBe('5 hidden word in "of the".');
  });

  it("returns just the entry for a down clue, even when the same number exists across", () => {
    expect(sliceNoteForClue(note, 1, "down")).toBe("1 charade.");
    expect(sliceNoteForClue(note, 3, "down")).toBe("3 reversal of EVIL.");
    expect(sliceNoteForClue(note, 10, "down")).toBe("10 &lit.");
  });

  it("returns '' when the note has no ACROSS/DOWN headers (freeform prose)", () => {
    expect(sliceNoteForClue("Just a freeform note about the puzzle.", 1, "across")).toBe("");
  });

  it("returns '' when the requested clue isn't in the note", () => {
    expect(sliceNoteForClue(note, 99, "across")).toBe("");
  });

  it("does not match a number embedded inside another word/number", () => {
    // "10" inside DOWN should not match a query for "1 across".
    const tricky = `ACROSS
21 a clue.
DOWN
1 first. 10 tenth.`;
    expect(sliceNoteForClue(tricky, 1, "down")).toBe("1 first.");
    expect(sliceNoteForClue(tricky, 21, "across")).toBe("21 a clue.");
    // No 2-across entry exists; should NOT return the "21" entry.
    expect(sliceNoteForClue(tricky, 2, "across")).toBe("");
  });

  it("returns '' for an empty note", () => {
    expect(sliceNoteForClue("", 1, "across")).toBe("");
  });
});
