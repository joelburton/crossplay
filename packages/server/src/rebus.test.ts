/**
 * End-to-end coverage for basic rebus: parse → fill → reveal → check
 * on a hand-crafted .ipuz with one multi-character solution cell.
 * Exercises the cap-aware code paths added in the rebus sprint without
 * needing a real-world puzzle.
 */

import { describe, expect, it } from "vitest";
import type { Cell, ClientMessage } from "@crossplay/shared";
import { MAX_REBUS_LEN, parseIpuzBuffer, writeIpuz } from "./ipuz.js";
import { applyCheck, applyFill, applyReveal, parseMessage } from "./ws.js";
import type { StoredBoard } from "./store.js";

// 3x3 fully open grid. Center cell holds the rebus "INSECT".
//   B    U      G          B,U,G
//   I    INSECT S    -->   "I"+"INSECT"+"S"  (one rebus cell)
//   G    O      T          G,O,T
const FIXTURE = {
  version: "http://ipuz.org/v2",
  kind: ["http://ipuz.org/crossword#1"],
  dimensions: { width: 3, height: 3 },
  puzzle: [
    [1, 2, 3],
    [4, 0, 0],
    [5, 0, 0],
  ],
  solution: [
    ["B", "U", "G"],
    ["I", "INSECT", "S"],
    ["G", "O", "T"],
  ],
  clues: {
    Across: [
      [1, "Annoyance"],
      [4, "A small creature"],
      [5, "Past tense of get"],
    ],
    Down: [
      [1, "Buggy"],
      [2, "Universal opener"],
      [3, "Got it"],
    ],
  },
};

function fixtureBuf(): Buffer {
  return Buffer.from(JSON.stringify(FIXTURE), "utf8");
}

function makeEntry(): StoredBoard {
  const parsed = parseIpuzBuffer("rebus", fixtureBuf());
  return {
    id: "rebus",
    state: parsed.state,
    solution: parsed.solution,
    initialSnapshot: structuredClone(parsed.state.snapshot),
    sockets: new Set(),
    chat: [],
    recentHellos: new Map(),
    cursorBySocket: new Map(),
    feedbackCounter: 0,
    dirty: false,
    flushTimer: null,
  } as unknown as StoredBoard;
}

describe("rebus: parse", () => {
  it("preserves the multi-character solution at the rebus cell", () => {
    const { solution } = parseIpuzBuffer("rebus", fixtureBuf());
    expect(solution[1]![1]).toEqual(["INSECT"]);
    expect(solution[0]![0]).toEqual(["B"]);
  });

  it("leaves the snapshot cell empty (rebus lives in the solution grid)", () => {
    const { state } = parseIpuzBuffer("rebus", fixtureBuf());
    const cell = state.snapshot.cells[1]![1]!;
    expect(cell.kind).toBe("cell");
    if (cell.kind === "cell") expect(cell.fill).toBeNull();
  });
});

describe("rebus: parseMessage validation", () => {
  it("accepts a multi-character fill within the cap", () => {
    const msg = parseMessage(
      JSON.stringify({ type: "fill", row: 1, col: 1, letter: "INSECT", clientVersion: 0 }),
    );
    expect(msg).toMatchObject({ type: "fill", letter: "INSECT" });
  });

  it("rejects a fill over the cap", () => {
    const over = "A".repeat(MAX_REBUS_LEN + 1);
    const msg = parseMessage(
      JSON.stringify({ type: "fill", row: 1, col: 1, letter: over, clientVersion: 0 }),
    );
    // parseMessage doesn't enforce length itself (it just type-checks the
    // string); the gate lives in applyFill. So the message parses fine
    // but applying it returns null.
    expect(msg).not.toBeNull();
  });
});

describe("rebus: applyFill", () => {
  it("writes a multi-character fill to the cell", () => {
    const e = makeEntry();
    const change = applyFill(e, {
      type: "fill",
      row: 1,
      col: 1,
      letter: "INSECT",
      clientVersion: 0,
    } as Extract<ClientMessage, { type: "fill" }>);
    expect(change).not.toBeNull();
    const cell = e.state.snapshot.cells[1]![1]! as Cell & { kind: "cell" };
    expect(cell.fill).toBe("INSECT");
  });

  it("rejects an over-cap fill", () => {
    const e = makeEntry();
    const change = applyFill(e, {
      type: "fill",
      row: 1,
      col: 1,
      letter: "A".repeat(MAX_REBUS_LEN + 1),
      clientVersion: 0,
    } as Extract<ClientMessage, { type: "fill" }>);
    expect(change).toBeNull();
  });
});

describe("rebus: applyReveal", () => {
  it("reveal-letter writes the full rebus solution into the cell", () => {
    const e = makeEntry();
    const changes = applyReveal(e, { type: "reveal", scope: "letter", row: 1, col: 1 });
    expect(changes).toHaveLength(1);
    const cell = e.state.snapshot.cells[1]![1]! as Cell & { kind: "cell" };
    expect(cell.fill).toBe("INSECT");
    expect(cell.revealed).toBe(true);
  });
});

describe("rebus: applyCheck", () => {
  it("marks a wrong rebus fill", () => {
    const e = makeEntry();
    applyFill(e, {
      type: "fill",
      row: 1,
      col: 1,
      letter: "WRONG",
      clientVersion: 0,
    } as Extract<ClientMessage, { type: "fill" }>);
    const changes = applyCheck(e, { type: "check", scope: "letter", row: 1, col: 1 });
    expect(changes).toHaveLength(1);
    const cell = e.state.snapshot.cells[1]![1]! as Cell & { kind: "cell" };
    expect(cell.wrong).toBe(true);
  });

  it("a correct rebus passes check (no change emitted, no wrong flag)", () => {
    const e = makeEntry();
    applyFill(e, {
      type: "fill",
      row: 1,
      col: 1,
      letter: "INSECT",
      clientVersion: 0,
    } as Extract<ClientMessage, { type: "fill" }>);
    const changes = applyCheck(e, { type: "check", scope: "letter", row: 1, col: 1 });
    expect(changes).toHaveLength(0);
    const cell = e.state.snapshot.cells[1]![1]! as Cell & { kind: "cell" };
    expect(cell.wrong).toBeUndefined();
  });

  it("accepts the first letter of a rebus answer as correct", () => {
    const e = makeEntry();
    applyFill(e, {
      type: "fill",
      row: 1,
      col: 1,
      letter: "I", // first letter of "INSECT"
      clientVersion: 0,
    } as Extract<ClientMessage, { type: "fill" }>);
    const changes = applyCheck(e, { type: "check", scope: "letter", row: 1, col: 1 });
    expect(changes).toHaveLength(0);
    const cell = e.state.snapshot.cells[1]![1]! as Cell & { kind: "cell" };
    expect(cell.wrong).toBeUndefined();
    expect(cell.fill).toBe("I");
  });

  it("rejects a partial prefix of a rebus answer", () => {
    // "IN" is neither the full answer "INSECT" nor its first letter,
    // so it should be flagged wrong (we accept full string OR sol[0]
    // only — see fillMatchesSolution).
    const e = makeEntry();
    applyFill(e, {
      type: "fill",
      row: 1,
      col: 1,
      letter: "IN",
      clientVersion: 0,
    } as Extract<ClientMessage, { type: "fill" }>);
    const changes = applyCheck(e, { type: "check", scope: "letter", row: 1, col: 1 });
    expect(changes).toHaveLength(1);
    const cell = e.state.snapshot.cells[1]![1]! as Cell & { kind: "cell" };
    expect(cell.wrong).toBe(true);
  });

  it("flags any other single letter as wrong against a rebus solution", () => {
    const e = makeEntry();
    applyFill(e, {
      type: "fill",
      row: 1,
      col: 1,
      letter: "X",
      clientVersion: 0,
    } as Extract<ClientMessage, { type: "fill" }>);
    const changes = applyCheck(e, { type: "check", scope: "letter", row: 1, col: 1 });
    expect(changes).toHaveLength(1);
    const cell = e.state.snapshot.cells[1]![1]! as Cell & { kind: "cell" };
    expect(cell.wrong).toBe(true);
  });
});

describe("rebus: writeIpuz round-trip", () => {
  it("preserves rebus solution and player fill through write/parse", () => {
    const original = parseIpuzBuffer("rebus", fixtureBuf());
    // Player has typed the answer.
    original.state.snapshot.cells[1]![1] = {
      kind: "cell",
      number: 4,
      fill: "INSECT",
    };
    const json = writeIpuz(original.state, original.solution);
    const reparsed = parseIpuzBuffer("rebus", Buffer.from(json, "utf8"));
    expect(reparsed.solution[1]![1]).toEqual(["INSECT"]);
    const cell = reparsed.state.snapshot.cells[1]![1]! as Cell & { kind: "cell" };
    expect(cell.fill).toBe("INSECT");
  });
});
