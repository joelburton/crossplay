import { describe, expect, it } from "vitest";
import type { Cell, PuzzleState } from "@crossplay/shared";
import type { StoredBoard } from "./store.js";
import {
  applyCheck,
  applyClear,
  applyFill,
  applyMark,
  applyReveal,
  checkScopeHasPencil,
  fillMatchesSolution,
  isPuzzleSolved,
  parseMessage,
  pruneRecentHellos,
  sanitizeName,
  shouldAnnounceHello,
} from "./ws.js";

// Mini grid (solution shown):
//   A B # C D    block at (0,2)
//   E F G H I
//   # # J # #    only J open in row 2
function entry(): StoredBoard {
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
      copyright: "",
      note: "",
      width: 5,
      height: 3,
      clues: { across: [], down: [] },
    },
    snapshot: { version: 0, cells },
  };
  const solution: (string[] | null)[][] = [
    [["A"], ["B"], null, ["C"], ["D"]],
    [["E"], ["F"], ["G"], ["H"], ["I"]],
    [null, null, ["J"], null, null],
  ];
  return {
    id: "test",
    state,
    // Deep-clone initial so mutations to `state.snapshot` don't bleed
    // into `initialSnapshot` (applyClear restores from this).
    initialSnapshot: JSON.parse(JSON.stringify(state.snapshot)) as typeof state.snapshot,
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
  it("parses scratchpadEdit", () => {
    expect(parseMessage(JSON.stringify({ type: "scratchpadEdit", text: "hi" }))).toEqual({
      type: "scratchpadEdit",
      text: "hi",
    });
  });
  it("rejects scratchpadEdit over the length cap", () => {
    const tooLong = "x".repeat(10_001);
    expect(parseMessage(JSON.stringify({ type: "scratchpadEdit", text: tooLong }))).toBeNull();
  });
  it("parses scratchpadTakeover", () => {
    expect(
      parseMessage(
        JSON.stringify({ type: "scratchpadTakeover", name: "Alice", color: "#1f77b4" }),
      ),
    ).toEqual({ type: "scratchpadTakeover", name: "Alice", color: "#1f77b4" });
  });
  it("rejects scratchpadTakeover with bad color", () => {
    expect(
      parseMessage(JSON.stringify({ type: "scratchpadTakeover", name: "Alice", color: "red" })),
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
  it("accepts multi-character (rebus) letters up to the cap", () => {
    const e = entry();
    const change = applyFill(e, fill(0, 0, "BLOCK"));
    expect(change).not.toBeNull();
    const cell = e.state.snapshot.cells[0]![0] as Cell & { kind: "cell" };
    expect(cell.fill).toBe("BLOCK");
  });
  it("rejects rebus letters over the cap", () => {
    expect(applyFill(entry(), fill(0, 0, "ABCDEFGHI"))).toBeNull();
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
  it("preserves author-prefilled cells from the initial snapshot", () => {
    // Construct an entry where (0,0) is author-prefilled with "A" and
    // the live snapshot has additional player fills at (0,1) and (1,1).
    const e = entry();
    const init00 = e.initialSnapshot.cells[0]![0] as Cell & { kind: "cell" };
    init00.fill = "A";
    const live00 = e.state.snapshot.cells[0]![0] as Cell & { kind: "cell" };
    live00.fill = "A"; // matches the initial — no clear-time change here
    const live01 = e.state.snapshot.cells[0]![1] as Cell & { kind: "cell" };
    live01.fill = "Z"; // player-typed
    const live11 = e.state.snapshot.cells[1]![1] as Cell & { kind: "cell" };
    live11.fill = "Y"; // player-typed
    const changes = applyClear(e);
    // Only the two player-typed cells changed; the prefilled one was
    // already aligned with initial and is skipped.
    expect(changes.map((c) => `${c.row},${c.col}`).sort()).toEqual(["0,1", "1,1"]);
    expect(live00.fill).toBe("A"); // prefilled survived
    expect(live01.fill).toBeNull();
    expect(live11.fill).toBeNull();
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

describe("shouldAnnounceHello", () => {
  const DEBOUNCE = 30_000;

  it("announces when there's no prior hello", () => {
    expect(shouldAnnounceHello(undefined, 1_000_000, DEBOUNCE)).toBe(true);
  });

  it("suppresses an immediate reconnect within the debounce window", () => {
    expect(shouldAnnounceHello(1_000_000, 1_005_000, DEBOUNCE)).toBe(false);
  });

  it("suppresses right at the boundary (<=)", () => {
    expect(shouldAnnounceHello(1_000_000, 1_000_000 + DEBOUNCE, DEBOUNCE)).toBe(false);
  });

  it("announces past the debounce window", () => {
    expect(shouldAnnounceHello(1_000_000, 1_000_000 + DEBOUNCE + 1, DEBOUNCE)).toBe(true);
  });
});

describe("sanitizeName", () => {
  it("leaves a normal name alone", () => {
    expect(sanitizeName("Joel")).toBe("Joel");
  });

  it("strips control characters (newline, tab, NUL)", () => {
    expect(sanitizeName("alice\n[admin]")).toBe("alice[admin]");
    expect(sanitizeName("a\tb")).toBe("ab");
    expect(sanitizeName("a b")).toBe("ab");
  });

  it("strips DEL (\\u007f)", () => {
    expect(sanitizeName("ab")).toBe("ab");
  });

  it("collapses internal whitespace runs to a single space", () => {
    expect(sanitizeName("a   b\t c")).toBe("a b c");
  });

  it("trims surrounding whitespace", () => {
    expect(sanitizeName("   alice   ")).toBe("alice");
  });

  it("returns the empty string for whitespace-only input", () => {
    expect(sanitizeName("   \t\n  ")).toBe("");
  });
});

describe("parseMessage chat name sanitization", () => {
  it("strips control chars from chat names", () => {
    const m = parseMessage(
      JSON.stringify({
        type: "chat",
        name: "alice\n[admin]",
        color: "#1f77b4",
        text: "hi",
      }),
    );
    expect(m).toMatchObject({ type: "chat", name: "alice[admin]" });
  });

  it("rejects a chat name that's empty after sanitization", () => {
    expect(
      parseMessage(JSON.stringify({ type: "chat", name: "\n\t\n", color: "#1f77b4", text: "hi" })),
    ).toBeNull();
  });

  it("strips control chars from hello names", () => {
    const m = parseMessage(
      JSON.stringify({ type: "hello", name: "joel ok", color: "#1f77b4" }),
    );
    expect(m).toMatchObject({ type: "hello", name: "joelok" });
  });
});

describe("pruneRecentHellos", () => {
  const MAX_AGE = 120_000;

  it("removes entries older than the cutoff", () => {
    const now = 1_000_000;
    const m = new Map<string, number>([
      ["alice", now - MAX_AGE - 1], // older → drop
      ["bob", now - 5_000],         // recent → keep
    ]);
    pruneRecentHellos(m, now, MAX_AGE);
    expect(m.has("alice")).toBe(false);
    expect(m.has("bob")).toBe(true);
  });

  it("keeps entries exactly at the cutoff", () => {
    const now = 1_000_000;
    const m = new Map<string, number>([["edge", now - MAX_AGE]]);
    pruneRecentHellos(m, now, MAX_AGE);
    expect(m.has("edge")).toBe(true);
  });

  it("is a no-op on an empty map", () => {
    const m = new Map<string, number>();
    pruneRecentHellos(m, 1_000_000, MAX_AGE);
    expect(m.size).toBe(0);
  });

  it("mutates the input map in place", () => {
    const m = new Map<string, number>([["old", 0]]);
    const ref = m;
    pruneRecentHellos(m, 1_000_000, MAX_AGE);
    expect(ref).toBe(m); // same reference
    expect(m.size).toBe(0);
  });
});

describe("parseMessage senderColor type-juggling", () => {
  // The contract: an invalid senderColor is silently dropped (so the
  // rest of the message still gets through). Numbers, null, objects,
  // booleans — none should cause parseMessage to reject the message
  // outright, and none should appear on the parsed result.
  const cases: Array<[string, unknown]> = [
    ["number", 42],
    ["null", null],
    ["empty object", {}],
    ["array", ["#1f77b4"]],
    ["boolean", true],
  ];
  for (const [label, senderColor] of cases) {
    it(`drops ${label} senderColor on fill without rejecting the message`, () => {
      const m = parseMessage(
        JSON.stringify({ type: "fill", row: 0, col: 0, letter: "A", clientVersion: 0, senderColor }),
      );
      expect(m).toMatchObject({ type: "fill", row: 0, col: 0, letter: "A" });
      expect(m).not.toHaveProperty("senderColor");
    });
    it(`drops ${label} senderColor on reveal without rejecting the message`, () => {
      const m = parseMessage(
        JSON.stringify({ type: "reveal", scope: "letter", row: 0, col: 0, senderColor }),
      );
      expect(m).toMatchObject({ type: "reveal", scope: "letter" });
      expect(m).not.toHaveProperty("senderColor");
    });
  }
});

describe("parseMessage pencil flag", () => {
  // pencil is parsed by `m.pencil === true`, so any other value (including
  // an explicit `false`) is treated as "no pencil flag attached" — the
  // parsed result has no `pencil` key at all. This matters because the
  // `applyFill` pencil branch keys off the presence of the flag.
  const base = { type: "fill", row: 0, col: 0, letter: "A", clientVersion: 0 };

  it("absent pencil produces a result with no pencil key", () => {
    const m = parseMessage(JSON.stringify(base));
    expect(m).not.toHaveProperty("pencil");
  });
  it("pencil:false produces the same shape as absent", () => {
    const m = parseMessage(JSON.stringify({ ...base, pencil: false }));
    expect(m).not.toHaveProperty("pencil");
  });
  it("pencil:true is preserved", () => {
    const m = parseMessage(JSON.stringify({ ...base, pencil: true }));
    expect(m).toMatchObject({ pencil: true });
  });
  it("pencil:'true' (string, truthy but not ===true) is dropped", () => {
    const m = parseMessage(JSON.stringify({ ...base, pencil: "true" }));
    expect(m).not.toHaveProperty("pencil");
  });
});

describe("applyFill non-A-Z input", () => {
  const cases: Array<[string, string]> = [
    ["digit", "5"],
    ["accented letter", "é"],
    ["control char", ""],
    ["space", " "],
    ["punctuation", "!"],
    ["multi-code-unit emoji", "😀"],
    ["over-cap rebus", "ABCDEFGHI"],
  ];
  for (const [label, letter] of cases) {
    it(`rejects ${label} (${JSON.stringify(letter)})`, () => {
      const e = entry();
      const change = applyFill(e, fill(0, 0, letter));
      expect(change).toBeNull();
      // Snapshot stays untouched: no version bump, fill still null.
      expect(e.state.snapshot.version).toBe(0);
      expect((e.state.snapshot.cells[0]![0] as { fill: string | null }).fill).toBeNull();
    });
  }
});

describe("applyReveal idempotence", () => {
  it("does not re-emit when the cell is already revealed to the solution", () => {
    const e = entry();
    const first = applyReveal(e, { type: "reveal", scope: "letter", row: 0, col: 0 });
    expect(first).toHaveLength(1);
    const versionAfterFirst = e.state.snapshot.version;
    const second = applyReveal(e, { type: "reveal", scope: "letter", row: 0, col: 0 });
    expect(second).toHaveLength(0);
    expect(e.state.snapshot.version).toBe(versionAfterFirst);
  });

  it("re-emits if the cell is revealed but currently shows wrong=true", () => {
    // Edge case: a previous check marked it wrong, then the user revealed.
    // After reveal, wrong must clear. If we then somehow set wrong back
    // and reveal again, the post-reveal state changes (wrong cleared),
    // so we expect a change.
    const e = entry();
    applyReveal(e, { type: "reveal", scope: "letter", row: 0, col: 0 });
    const cell = e.state.snapshot.cells[0]![0] as Cell & { kind: "cell" };
    cell.wrong = true; // simulate a check after reveal
    const changes = applyReveal(e, { type: "reveal", scope: "letter", row: 0, col: 0 });
    expect(changes).toHaveLength(1);
    expect(cell.wrong).toBeUndefined();
  });

  it("word-scope reveal over a partially-revealed word emits only the still-pending cells", () => {
    const e = entry();
    // Pre-reveal one cell of the across word at row 1.
    applyReveal(e, { type: "reveal", scope: "letter", row: 1, col: 2 });
    const before = e.state.snapshot.version;
    const changes = applyReveal(e, {
      type: "reveal",
      scope: "word",
      row: 1,
      col: 0,
      dir: "across",
    });
    // The word is 5 cells; one was already revealed, so 4 new emissions.
    expect(changes).toHaveLength(4);
    expect(e.state.snapshot.version).toBe(before + 4);
  });
});

describe("checkScopeHasPencil", () => {
  it("returns false when nothing is filled in scope", () => {
    const e = entry();
    expect(
      checkScopeHasPencil(e, { type: "check", scope: "word", row: 1, col: 0, dir: "across" }),
    ).toBe(false);
  });

  it("returns false when the word has only pen fills", () => {
    const e = entry();
    (e.state.snapshot.cells[1]![0] as { fill: string | null }).fill = "E";
    (e.state.snapshot.cells[1]![1] as { fill: string | null }).fill = "F";
    expect(
      checkScopeHasPencil(e, { type: "check", scope: "word", row: 1, col: 0, dir: "across" }),
    ).toBe(false);
  });

  it("returns true when at least one cell in the word is pencil", () => {
    const e = entry();
    applyFill(e, { type: "fill", row: 1, col: 0, letter: "X", clientVersion: 0 }); // pen
    applyFill(e, { type: "fill", row: 1, col: 2, letter: "Z", clientVersion: 0, pencil: true }); // pencil
    expect(
      checkScopeHasPencil(e, { type: "check", scope: "word", row: 1, col: 0, dir: "across" }),
    ).toBe(true);
  });

  it("ignores empty pencil-flagged cells (no fill = nothing to check)", () => {
    // A cell with pencil:true but fill:null shouldn't count — there's no
    // letter to skip. (Today applyFill never produces this state, but
    // checkScopeHasPencil shouldn't depend on that.)
    const e = entry();
    const cell = e.state.snapshot.cells[1]![0] as Cell & { kind: "cell" };
    cell.pencil = true;
    cell.fill = null;
    expect(
      checkScopeHasPencil(e, { type: "check", scope: "word", row: 1, col: 0, dir: "across" }),
    ).toBe(false);
  });

  it("scans the whole grid at puzzle scope", () => {
    const e = entry();
    applyFill(e, { type: "fill", row: 2, col: 2, letter: "J", clientVersion: 0, pencil: true });
    expect(checkScopeHasPencil(e, { type: "check", scope: "puzzle" })).toBe(true);
  });
});

describe("applyFill against given cells", () => {
  it("refuses to mutate a given cell (returns null)", () => {
    const e = entry();
    // Plant a given at (0, 0): author letter "A", immutable.
    e.state.snapshot.cells[0]![0] = { kind: "cell", number: 1, fill: "A", given: true };
    e.initialSnapshot.cells[0]![0] = { kind: "cell", number: 1, fill: "A", given: true };
    const before = e.state.snapshot.version;
    const change = applyFill(e, fill(0, 0, "Z"));
    expect(change).toBeNull();
    expect(e.state.snapshot.version).toBe(before);
    const cell = e.state.snapshot.cells[0]![0]!;
    expect(cell.kind === "cell" && cell.fill).toBe("A");
  });

  it("refuses to erase a given (Backspace wire)", () => {
    const e = entry();
    e.state.snapshot.cells[0]![0] = { kind: "cell", number: 1, fill: "A", given: true };
    const change = applyFill(e, fill(0, 0, null));
    expect(change).toBeNull();
    const cell = e.state.snapshot.cells[0]![0]!;
    expect(cell.kind === "cell" && cell.fill).toBe("A");
  });
});

describe("applyMark", () => {
  it("sets a break mark on the right edge", () => {
    const e = entry();
    const change = applyMark(e, { type: "mark", row: 0, col: 0, side: "right", markType: "break" });
    expect(change).not.toBeNull();
    const cell = e.state.snapshot.cells[0]![0]!;
    expect(cell.kind === "cell" && cell.markRight).toBe("break");
  });

  it("cycles to hyphen on the same side without clearing the other", () => {
    const e = entry();
    applyMark(e, { type: "mark", row: 0, col: 0, side: "right", markType: "break" });
    applyMark(e, { type: "mark", row: 0, col: 0, side: "bottom", markType: "break" });
    applyMark(e, { type: "mark", row: 0, col: 0, side: "right", markType: "hyphen" });
    const cell = e.state.snapshot.cells[0]![0]!;
    if (cell.kind === "cell") {
      expect(cell.markRight).toBe("hyphen");
      expect(cell.markBottom).toBe("break");
    }
  });

  it("clears a mark when markType is null", () => {
    const e = entry();
    applyMark(e, { type: "mark", row: 0, col: 0, side: "right", markType: "break" });
    const change = applyMark(e, { type: "mark", row: 0, col: 0, side: "right", markType: null });
    expect(change).not.toBeNull();
    const cell = e.state.snapshot.cells[0]![0]!;
    expect(cell.kind === "cell" && cell.markRight).toBeUndefined();
  });

  it("returns null on a no-op (same mark already there, or clearing empty side)", () => {
    const e = entry();
    applyMark(e, { type: "mark", row: 0, col: 0, side: "right", markType: "break" });
    expect(
      applyMark(e, { type: "mark", row: 0, col: 0, side: "right", markType: "break" }),
    ).toBeNull();
    expect(
      applyMark(e, { type: "mark", row: 0, col: 0, side: "bottom", markType: null }),
    ).toBeNull();
  });

  it("refuses to mark a block", () => {
    const e = entry();
    expect(
      applyMark(e, { type: "mark", row: 0, col: 2, side: "right", markType: "break" }),
    ).toBeNull();
  });

  it("Clear board wipes any marks the player added", () => {
    const e = entry();
    applyMark(e, { type: "mark", row: 0, col: 0, side: "right", markType: "break" });
    applyMark(e, { type: "mark", row: 0, col: 1, side: "bottom", markType: "hyphen" });
    const changes = applyClear(e);
    expect(changes.length).toBeGreaterThanOrEqual(2);
    const a = e.state.snapshot.cells[0]![0]!;
    const b = e.state.snapshot.cells[0]![1]!;
    if (a.kind === "cell") expect(a.markRight).toBeUndefined();
    if (b.kind === "cell") expect(b.markBottom).toBeUndefined();
  });
});

describe("isPuzzleSolved", () => {
  function fillAll(e: ReturnType<typeof entry>, letters: string[][]) {
    for (let r = 0; r < letters.length; r++) {
      for (let c = 0; c < letters[r]!.length; c++) {
        const cell = e.state.snapshot.cells[r]![c]!;
        if (cell.kind !== "cell") continue;
        cell.fill = letters[r]![c]!;
      }
    }
  }

  it("is false on an empty grid", () => {
    expect(isPuzzleSolved(entry())).toBe(false);
  });

  it("is true when every open cell matches the solution", () => {
    const e = entry();
    fillAll(e, [
      ["A", "B", "", "C", "D"],
      ["E", "F", "G", "H", "I"],
      ["", "", "J", "", ""],
    ]);
    expect(isPuzzleSolved(e)).toBe(true);
  });

  it("is false if any open cell is wrong", () => {
    const e = entry();
    fillAll(e, [
      ["A", "B", "", "C", "D"],
      ["E", "F", "G", "H", "I"],
      ["", "", "X", "", ""], // J → X
    ]);
    expect(isPuzzleSolved(e)).toBe(false);
  });

  it("is false if any open cell is empty", () => {
    const e = entry();
    fillAll(e, [
      ["A", "B", "", "C", "D"],
      ["E", "F", "G", "H", "I"],
      ["", "", "", "", ""], // J unfilled
    ]);
    expect(isPuzzleSolved(e)).toBe(false);
  });

  it("treats the rebus first-letter rule as solved", () => {
    const e = entry();
    e.solution[1]![2] = ["GROW"]; // multi-letter sol at (1,2)
    fillAll(e, [
      ["A", "B", "", "C", "D"],
      ["E", "F", "G", "H", "I"], // typed just "G" against "GROW"
      ["", "", "J", "", ""],
    ]);
    expect(isPuzzleSolved(e)).toBe(true);
  });

  it("treats any Schrödinger alternate as solved", () => {
    const e = entry();
    e.solution[0]![0] = ["A", "E"];
    fillAll(e, [
      ["E", "B", "", "C", "D"], // alternate at (0,0)
      ["E", "F", "G", "H", "I"],
      ["", "", "J", "", ""],
    ]);
    expect(isPuzzleSolved(e)).toBe(true);
  });
});

describe("parseMessage mark", () => {
  it("accepts a valid mark", () => {
    expect(
      parseMessage(
        JSON.stringify({ type: "mark", row: 1, col: 2, side: "right", markType: "break" }),
      ),
    ).toEqual({ type: "mark", row: 1, col: 2, side: "right", markType: "break" });
  });

  it("accepts markType: null (clear)", () => {
    expect(
      parseMessage(
        JSON.stringify({ type: "mark", row: 0, col: 0, side: "bottom", markType: null }),
      ),
    ).toEqual({ type: "mark", row: 0, col: 0, side: "bottom", markType: null });
  });

  it("rejects an unknown side", () => {
    expect(
      parseMessage(
        JSON.stringify({ type: "mark", row: 0, col: 0, side: "top", markType: "break" }),
      ),
    ).toBeNull();
  });

  it("rejects an unknown markType", () => {
    expect(
      parseMessage(
        JSON.stringify({ type: "mark", row: 0, col: 0, side: "right", markType: "splat" }),
      ),
    ).toBeNull();
  });
});

describe("applyReveal / applyCheck against Schrödinger cells", () => {
  it("check accepts either accepted answer", () => {
    const e = entry();
    e.solution[0]![0] = ["A", "E"];
    // Player typed the alternate "E"; check should not mark wrong.
    e.state.snapshot.cells[0]![0] = { kind: "cell", number: 1, fill: "E" };
    const changes = applyCheck(e, { type: "check", scope: "letter", row: 0, col: 0 });
    expect(changes).toHaveLength(0);
    const cell = e.state.snapshot.cells[0]![0]!;
    expect(cell.kind === "cell" && cell.wrong).toBeFalsy();
  });

  it("reveal writes the canonical (first) answer even when an alternate is typed", () => {
    const e = entry();
    e.solution[0]![0] = ["A", "E"];
    e.state.snapshot.cells[0]![0] = { kind: "cell", number: 1, fill: "E" };
    const changes = applyReveal(e, { type: "reveal", scope: "letter", row: 0, col: 0 });
    expect(changes).toHaveLength(1);
    const cell = e.state.snapshot.cells[0]![0]!;
    expect(cell.kind === "cell" && cell.fill).toBe("A");
    expect(cell.kind === "cell" && cell.revealed).toBe(true);
  });
});

describe("fillMatchesSolution", () => {
  it("returns false when the solution is null/undefined", () => {
    expect(fillMatchesSolution("A", null)).toBe(false);
    expect(fillMatchesSolution("A", undefined)).toBe(false);
  });

  it("returns true on an exact match (single letter)", () => {
    expect(fillMatchesSolution("A", ["A"])).toBe(true);
  });

  it("returns true on an exact match (rebus full string)", () => {
    expect(fillMatchesSolution("BLOCK", ["BLOCK"])).toBe(true);
  });

  it("returns true when fill is the first letter of a rebus solution (NYT)", () => {
    expect(fillMatchesSolution("B", ["BLOCK"])).toBe(true);
  });

  it("rejects an arbitrary prefix of a rebus solution", () => {
    // Only the full answer OR the first letter are accepted — partial
    // prefixes like "BL" must NOT be treated as correct.
    expect(fillMatchesSolution("BL", ["BLOCK"])).toBe(false);
    expect(fillMatchesSolution("BLO", ["BLOCK"])).toBe(false);
    expect(fillMatchesSolution("BLOC", ["BLOCK"])).toBe(false);
  });

  it("rejects a wrong letter against a rebus solution", () => {
    expect(fillMatchesSolution("X", ["BLOCK"])).toBe(false);
    expect(fillMatchesSolution("Z", ["BLOCK"])).toBe(false);
  });

  it("first-letter rule does NOT apply when the solution is a single letter", () => {
    // sol.length > 1 gate: a one-character solution requires exact match.
    expect(fillMatchesSolution("A", ["B"])).toBe(false);
  });

  it("accepts any element of a Schrödinger answer array", () => {
    expect(fillMatchesSolution("S", ["S", "Z"])).toBe(true);
    expect(fillMatchesSolution("Z", ["S", "Z"])).toBe(true);
    expect(fillMatchesSolution("Q", ["S", "Z"])).toBe(false);
  });

  it("applies the rebus first-letter rule per-element in a Schrödinger array", () => {
    // BLOCK accepts "B"; STAR accepts "S"; both alternates apply.
    expect(fillMatchesSolution("B", ["BLOCK", "STAR"])).toBe(true);
    expect(fillMatchesSolution("S", ["BLOCK", "STAR"])).toBe(true);
    expect(fillMatchesSolution("X", ["BLOCK", "STAR"])).toBe(false);
  });
});
