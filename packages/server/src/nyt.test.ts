/**
 * Unit tests for the NYT JSON → PuzzleState conversion, the stored-
 * cookie-jar parser, and the typed-error mapping in nytGetJson. The
 * network-touching list / by-id helpers are exercised indirectly via
 * http.test.ts (which stubs global fetch). Here we focus on the pure
 * conversion logic so a regression shows up with a useful test name.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";
import { describe, expect, it } from "vitest";
import {
  NytFetchError,
  applyOverlayCircles,
  applyOverlayMarkings,
  detectOverlayCircles,
  detectOverlayMarkings,
  nytResponseToPuzzleState,
  parseStoredCookieJar,
} from "./nyt.js";
import type { Cell } from "@crossplay/shared";

const FIXTURE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");

// Helper to assemble a flat NYT-v6-shaped response. Width/height
// inferred from `cells.length`. Each `cell` is a partial shape — the
// converter only reads `type`, `answer`, `label`, `moreAnswers`. Clues
// are passed through verbatim; the converter walks the body.clues
// array directly.
function makeResp(opts: {
  width: number;
  height: number;
  cells: Array<{
    type?: number;
    answer?: string;
    label?: string;
    moreAnswers?: { valid: string[] };
  }>;
  clues?: Array<{ text: string; direction: string; label: string }>;
  title?: string;
  publicationDate?: string;
  constructors?: string[];
  editor?: string;
  copyright?: string;
  notes?: Array<{ text: string }>;
}) {
  return {
    body: [
      {
        dimensions: { width: opts.width, height: opts.height },
        cells: opts.cells,
        clues: opts.clues ?? [],
      },
    ],
    title: opts.title,
    publicationDate: opts.publicationDate,
    constructors: opts.constructors,
    editor: opts.editor,
    copyright: opts.copyright,
    notes: opts.notes,
  };
}

describe("nytResponseToPuzzleState: cells", () => {
  it("treats type=0 and type=4 as blocks, but only type=4 is hidden", () => {
    const resp = makeResp({
      width: 3,
      height: 1,
      cells: [
        { type: 0 },
        { type: 4 },
        { type: 1, answer: "A", label: "1" },
      ],
    });
    const { state, solution } = nytResponseToPuzzleState(resp, "test");
    const row = state.snapshot.cells[0]!;
    expect(row[0]).toEqual({ kind: "block" });
    expect(row[1]).toEqual({ kind: "block", hidden: true });
    expect(row[2]).toMatchObject({ kind: "cell", number: 1, fill: null });
    expect(solution[0]).toEqual([null, null, ["A"]]);
  });

  it("marks circled (type=2) and shaded (type=3) cells", () => {
    const resp = makeResp({
      width: 2,
      height: 1,
      cells: [
        { type: 2, answer: "A" },
        { type: 3, answer: "B" },
      ],
    });
    const { state } = nytResponseToPuzzleState(resp, "test");
    const row = state.snapshot.cells[0]!;
    expect(row[0]).toMatchObject({ kind: "cell", circled: true });
    expect(row[0]).not.toHaveProperty("shaded");
    expect(row[1]).toMatchObject({ kind: "cell", shaded: true });
    expect(row[1]).not.toHaveProperty("circled");
  });

  it("preserves rebus answers in the solution grid", () => {
    const resp = makeResp({
      width: 1,
      height: 1,
      cells: [{ type: 1, answer: "PIE" }],
    });
    const { solution } = nytResponseToPuzzleState(resp, "test");
    expect(solution[0]![0]).toEqual(["PIE"]);
  });

  it("captures Schrödinger alternates and dedupes the primary", () => {
    const resp = makeResp({
      width: 1,
      height: 1,
      cells: [
        {
          type: 1,
          answer: "M",
          moreAnswers: { valid: ["M", "F"] },
        },
      ],
    });
    const { solution } = nytResponseToPuzzleState(resp, "test");
    expect(solution[0]![0]).toEqual(["M", "F"]);
  });

  it("treats cells with no answer string as blocks even at type=1", () => {
    // Sanity guard: data_to_puz.py's `gridchar` uses `'answer' in cell`
    // as the open/closed signal. We mirror that — type alone isn't
    // enough.
    const resp = makeResp({
      width: 1,
      height: 1,
      cells: [{ type: 1 }],
    });
    const { state, solution } = nytResponseToPuzzleState(resp, "test");
    expect(state.snapshot.cells[0]![0]).toEqual({ kind: "block" });
    expect(solution[0]![0]).toBeNull();
  });
});

describe("nytResponseToPuzzleState: clues", () => {
  it("splits by direction and sorts by number", () => {
    const resp = makeResp({
      width: 1,
      height: 1,
      cells: [{ type: 1, answer: "A" }],
      clues: [
        { text: "two down", direction: "Down", label: "2" },
        { text: "one down", direction: "Down", label: "1" },
        { text: "one across", direction: "Across", label: "1" },
      ],
    });
    const { state } = nytResponseToPuzzleState(resp, "test");
    expect(state.meta.clues.across).toEqual([{ number: 1, text: "one across" }]);
    expect(state.meta.clues.down).toEqual([
      { number: 1, text: "one down" },
      { number: 2, text: "two down" },
    ]);
  });

  it("strips HTML and decodes entities in clue text", () => {
    const resp = makeResp({
      width: 1,
      height: 1,
      cells: [{ type: 1, answer: "A" }],
      clues: [
        {
          text: "<i>Tilted</i>: KNO<sub>3</sub> &mdash; &#65;",
          direction: "Across",
          label: "1",
        },
      ],
    });
    const { state } = nytResponseToPuzzleState(resp, "test");
    expect(state.meta.clues.across[0]!.text).toBe("_Tilted_: KNO3 — A");
  });
});

describe("nytResponseToPuzzleState: meta", () => {
  it("formats title with weekday + slashed date when publicationDate is present", () => {
    const resp = makeResp({
      width: 1,
      height: 1,
      cells: [{ type: 1, answer: "A" }],
      title: "Double Meanings",
      publicationDate: "2026-05-17", // Sunday
    });
    const { state } = nytResponseToPuzzleState(resp, "test");
    expect(state.meta.title).toBe("NYT Sun 5/17/26: Double Meanings");
  });

  it("falls back to 'Untitled' and the bare prefix when title is missing", () => {
    const resp = makeResp({
      width: 1,
      height: 1,
      cells: [{ type: 1, answer: "A" }],
    });
    const { state } = nytResponseToPuzzleState(resp, "test");
    expect(state.meta.title).toBe("NYT: Untitled");
  });

  it("joins constructors and appends editor with a slash", () => {
    const resp = makeResp({
      width: 1,
      height: 1,
      cells: [{ type: 1, answer: "A" }],
      constructors: ["Alice", "Bob"],
      editor: "Will Shortz",
    });
    const { state } = nytResponseToPuzzleState(resp, "test");
    expect(state.meta.author).toBe("Alice, Bob / Will Shortz");
  });

  it("wraps the copyright string with © prefix and NYT suffix", () => {
    const resp = makeResp({
      width: 1,
      height: 1,
      cells: [{ type: 1, answer: "A" }],
      copyright: "2026",
    });
    const { state } = nytResponseToPuzzleState(resp, "test");
    expect(state.meta.copyright).toBe("© 2026, The New York Times");
  });

  it("emits an empty copyright when the source has none", () => {
    const resp = makeResp({
      width: 1,
      height: 1,
      cells: [{ type: 1, answer: "A" }],
    });
    const { state } = nytResponseToPuzzleState(resp, "test");
    expect(state.meta.copyright).toBe("");
  });

  it("joins multi-line notes with double-newline", () => {
    const resp = makeResp({
      width: 1,
      height: 1,
      cells: [{ type: 1, answer: "A" }],
      notes: [{ text: "first" }, { text: "second" }],
    });
    const { state } = nytResponseToPuzzleState(resp, "test");
    expect(state.meta.note).toBe("first\n\nsecond");
  });

  it("uses publicationDate as the id, falling back to the caller's hint", () => {
    const withDate = nytResponseToPuzzleState(
      makeResp({
        width: 1,
        height: 1,
        cells: [{ type: 1, answer: "A" }],
        publicationDate: "2026-05-17",
      }),
      "fallback",
    );
    expect(withDate.state.meta.id).toBe("2026-05-17");
    const withoutDate = nytResponseToPuzzleState(
      makeResp({
        width: 1,
        height: 1,
        cells: [{ type: 1, answer: "A" }],
      }),
      "fallback",
    );
    expect(withoutDate.state.meta.id).toBe("fallback");
  });
});

describe("nytResponseToPuzzleState: validation", () => {
  it("throws NytFetchError when cell count doesn't match dimensions", () => {
    const resp = makeResp({
      width: 2,
      height: 2,
      cells: [{ type: 0 }, { type: 0 }],
    });
    expect(() => nytResponseToPuzzleState(resp, "test")).toThrow(NytFetchError);
  });

  it("throws NytFetchError on a missing body", () => {
    expect(() =>
      nytResponseToPuzzleState(
        { body: [] } as unknown as Parameters<typeof nytResponseToPuzzleState>[0],
        "test",
      ),
    ).toThrow(NytFetchError);
  });
});

describe("parseStoredCookieJar", () => {
  /** Shorthand for the canonical paste shape: base64-of-JSON. */
  const b64 = (obj: unknown) =>
    Buffer.from(JSON.stringify(obj), "utf8").toString("base64");

  it("returns null for null/empty input (covers the column-is-NULL case)", () => {
    expect(parseStoredCookieJar(null)).toBeNull();
    expect(parseStoredCookieJar("")).toBeNull();
    expect(parseStoredCookieJar("   ")).toBeNull();
    expect(parseStoredCookieJar(undefined)).toBeNull();
  });

  it("accepts raw JSON (back-compat shape for already-stored values)", () => {
    expect(parseStoredCookieJar('{"NYT-S": "abc", "nyt-a": "xyz"}')).toEqual({
      "NYT-S": "abc",
      "nyt-a": "xyz",
    });
  });

  it("accepts base64-of-JSON (the dump-nyt-cookies output shape)", () => {
    expect(parseStoredCookieJar(b64({ "NYT-S": "abc" }))).toEqual({ "NYT-S": "abc" });
  });

  it("tolerates whitespace / newlines inside the base64 (terminal-wrap paste)", () => {
    // Inject newlines every 30 chars to simulate a terminal that
    // wrapped the long line during selection.
    const raw = b64({ "NYT-S": "abc", "nyt-a": "xyz" });
    const wrapped = raw.match(/.{1,30}/g)!.join("\n");
    expect(parseStoredCookieJar(wrapped)).toEqual({ "NYT-S": "abc", "nyt-a": "xyz" });
  });

  it("throws with a user-friendly message on base64 that isn't JSON", () => {
    // Valid base64, but decodes to "hello world" (not a JSON object).
    const garbage = Buffer.from("hello world").toString("base64");
    expect(() => parseStoredCookieJar(garbage)).toThrow(/valid JSON/i);
  });

  it("throws on a malformed raw-JSON paste", () => {
    expect(() => parseStoredCookieJar("{not: json}")).toThrow(NytFetchError);
  });

  it("throws when the decoded value isn't a plain object", () => {
    expect(() => parseStoredCookieJar(b64([]))).toThrow(/object of/i);
    expect(() => parseStoredCookieJar(b64("just a string"))).toThrow(/object of/i);
  });

  it("throws when a value isn't a string", () => {
    expect(() => parseStoredCookieJar(b64({ "NYT-S": 123 }))).toThrow(/not a string/i);
  });

  it("throws when the decoded object is empty", () => {
    expect(() => parseStoredCookieJar(b64({}))).toThrow(/empty/i);
  });
});

describe("detectOverlayCircles + applyOverlayCircles", () => {
  // The fixture is the actual NYT overlay PNG for the 2026-04-30 daily
  // ("Oscar Bait"), which carries six circles drawn on top of shaded
  // theme cells in three rows (TROUT, SALMON, CHAR). The v6 cell
  // payload's `type` field can't represent circled+shaded together, so
  // these circles only exist in the raster overlay.
  it("finds the six circles in the 4/30/26 overlay", () => {
    const buf = readFileSync(resolve(FIXTURE_DIR, "nyt-overlay-salmon-trout-char.png"));
    const png = PNG.sync.read(buf);
    const cells = detectOverlayCircles(png, 15, 15);
    expect(new Set(cells)).toEqual(
      new Set(["2,11", "2,13", "4,4", "4,6", "10,11", "10,13"]),
    );
  });

  it("unions detected circles onto an existing cell grid", () => {
    const cells: Cell[][] = [
      [
        { kind: "cell", number: null, fill: null, shaded: true },
        { kind: "block" },
      ],
    ];
    applyOverlayCircles(cells, new Set(["0,0", "0,1"]));
    // Shaded cell becomes both shaded AND circled.
    expect(cells[0]![0]).toMatchObject({ shaded: true, circled: true });
    // Block at (0,1) is unchanged — we never add `circled` to a block.
    expect(cells[0]![1]).toEqual({ kind: "block" });
  });
});

describe("detectOverlayMarkings: bars", () => {
  // The fixture is the actual NYT overlay PNG for the 2026-04-02 daily
  // ("WTVEW | EHERE / TT SHIPS SAILED" — a barred Thursday). Eight
  // vertical bars sit on inter-cell boundaries; the per-cell `type`
  // field can't express bars at all, so they only exist in the raster
  // overlay.
  it("finds the eight vertical bars in the 4/2/26 overlay", () => {
    const buf = readFileSync(resolve(FIXTURE_DIR, "nyt-overlay-bars-2026-04-02.png"));
    const png = PNG.sync.read(buf);
    const m = detectOverlayMarkings(png, 15, 15);
    expect(m.circles).toEqual(new Set());
    expect(m.barsBottom).toEqual(new Set());
    // "r,c" is the LEFT cell — bar is on its right edge.
    expect(m.barsRight).toEqual(
      new Set([
        "2,0", "2,1",   // row 16: two close bars
        "4,2", "4,7",   // row 22: bars next to "22" and before "24"
        "7,4", "7,7",   // row 35: bars between 36/37 and further right
        "10,0", "10,9", // row 50: bar between 50/51, bar far right
      ]),
    );
  });

  it("the circle-only fixture decodes as circles with no spurious bars", () => {
    // Regression guard: a roughly-square circle outline must not get
    // misclassified as a bar by the aspect-ratio test.
    const buf = readFileSync(resolve(FIXTURE_DIR, "nyt-overlay-salmon-trout-char.png"));
    const png = PNG.sync.read(buf);
    const m = detectOverlayMarkings(png, 15, 15);
    expect(m.circles.size).toBe(6);
    expect(m.barsRight).toEqual(new Set());
    expect(m.barsBottom).toEqual(new Set());
  });

  it("applyOverlayMarkings sets markRight/markBottom 'break' on the named cells", () => {
    const cells: Cell[][] = [
      [
        { kind: "cell", number: null, fill: null },
        { kind: "cell", number: null, fill: null },
      ],
      [
        { kind: "cell", number: null, fill: null },
        { kind: "block" },
      ],
    ];
    applyOverlayMarkings(cells, {
      circles: new Set(),
      barsRight: new Set(["0,0"]),
      barsBottom: new Set(["0,1", "1,1"]),
    });
    expect(cells[0]![0]).toMatchObject({ markRight: "break" });
    expect(cells[0]![1]).toMatchObject({ markBottom: "break" });
    // Block at (1,1) is unchanged — we never write marks onto a block.
    expect(cells[1]![1]).toEqual({ kind: "block" });
  });
});
