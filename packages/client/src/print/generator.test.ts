// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import type { Cell, PuzzleState } from "@crossplay/shared";

// Capture every jsPDF call made by the generator. Each method records
// itself and returns `this`, so chained-style calls work.
type Call = { fn: string; args: unknown[] };
const calls: Call[] = [];

function makeMockDoc() {
  const draw = (fn: string) =>
    function (this: unknown, ...args: unknown[]) {
      calls.push({ fn, args });
      return this;
    };
  return {
    setFont: draw("setFont"),
    setFontSize: draw("setFontSize"),
    setFillColor: draw("setFillColor"),
    setTextColor: draw("setTextColor"),
    setDrawColor: draw("setDrawColor"),
    setLineWidth: draw("setLineWidth"),
    text: draw("text"),
    rect: draw("rect"),
    line: draw("line"),
    ellipse: draw("ellipse"),
    addPage: draw("addPage"),
    splitTextToSize: (text: string) => [text],
    getTextWidth: () => 10,
    output: (type: string) => {
      calls.push({ fn: "output", args: [type] });
      return new Blob(["pdf"], { type: "application/pdf" });
    },
  };
}

vi.mock("jspdf", () => ({
  jsPDF: function MockJsPDF(this: ReturnType<typeof makeMockDoc>) {
    Object.assign(this, makeMockDoc());
  },
}));

function cell(number: number | null, fill: string | null = null): Cell {
  return { kind: "cell", number, fill };
}

function makePuzzle(): PuzzleState {
  const cells: Cell[][] = [
    [cell(1), cell(2), cell(3)],
    [cell(4), cell(null), cell(null)],
    [cell(5), cell(null), cell(null)],
  ];
  return {
    meta: {
      id: "b1",
      title: "Smoke Test",
      author: "Tester",
      copyright: "© 2026",
      note: "",
      width: 3,
      height: 3,
      clues: {
        across: [
          { number: 1, text: "first across clue" },
          { number: 4, text: "second across clue" },
        ],
        down: [
          { number: 1, text: "first down clue" },
          { number: 2, text: "second down clue" },
          { number: 3, text: "third down clue" },
        ],
      },
    },
    snapshot: { version: 0, cells },
  };
}

function makePencilPuzzle(): PuzzleState {
  const cells: Cell[][] = [
    [
      { kind: "cell", number: 1, fill: "P", pencil: true },
      { kind: "cell", number: 2, fill: "B" },
    ],
    [
      { kind: "cell", number: 3, fill: null },
      { kind: "cell", number: null, fill: null },
    ],
  ];
  return {
    meta: {
      id: "p1",
      title: "Pencil Test",
      author: "",
      copyright: "",
      note: "",
      width: 2,
      height: 2,
      clues: { across: [], down: [] },
    },
    snapshot: { version: 0, cells },
  };
}

describe("generateCrosswordPdf", () => {
  it("returns a Blob and exercises the right jsPDF surface", async () => {
    calls.length = 0;
    const { generateCrosswordPdf } = await import("./generator");
    const blob = await generateCrosswordPdf(makePuzzle());
    expect(blob).toBeInstanceOf(Blob);

    // Title rendered: Times-Bold + the title text.
    const setFonts = calls.filter((c) => c.fn === "setFont");
    expect(setFonts.some((c) => c.args[0] === "times" && c.args[1] === "bold")).toBe(true);
    const texts = calls.filter((c) => c.fn === "text").map((c) => c.args[0]);
    expect(texts).toContain("Smoke Test");

    // All clue texts present.
    expect(texts).toContain("first across clue");
    expect(texts).toContain("first down clue");

    // Headings emitted.
    expect(texts).toContain("ACROSS");
    expect(texts).toContain("DOWN");

    // Grid: one rect per open cell + zero blocks here = 9 rects from grid.
    // (Plus possibly more from shaded background — none in this fixture.)
    const rects = calls.filter((c) => c.fn === "rect");
    expect(rects.length).toBeGreaterThanOrEqual(9);

    // Output went through doc.output("blob").
    expect(calls.find((c) => c.fn === "output")).toBeTruthy();
  });

  it("renders pencil fills in italic + light gray", async () => {
    calls.length = 0;
    const { generateCrosswordPdf } = await import("./generator");
    await generateCrosswordPdf(makePencilPuzzle());

    // Find the text() call that drew the "P" letter, and inspect the
    // most recent setFont / setTextColor before it. Pencil → italic +
    // gray; the regular "B" cell → bold + (no text-color override).
    const idxP = calls.findIndex((c) => c.fn === "text" && c.args[0] === "P");
    const idxB = calls.findIndex((c) => c.fn === "text" && c.args[0] === "B");
    expect(idxP).toBeGreaterThan(-1);
    expect(idxB).toBeGreaterThan(-1);

    const fontBeforeP = lastBefore(idxP, "setFont");
    expect(fontBeforeP?.args[1]).toBe("italic");
    const colorBeforeP = lastBefore(idxP, "setTextColor");
    // Light gray (140,140,140).
    expect(colorBeforeP?.args).toEqual([140, 140, 140]);

    const fontBeforeB = lastBefore(idxB, "setFont");
    expect(fontBeforeB?.args[1]).toBe("bold");

    // After the pencil cell is drawn we restore the black text color
    // so subsequent cells aren't gray.
    const restore = calls
      .slice(idxP + 1)
      .find((c) => c.fn === "setTextColor");
    expect(restore?.args).toEqual([0, 0, 0]);
  });
});

function lastBefore(idx: number, fn: string): Call | undefined {
  for (let i = idx - 1; i >= 0; i--) {
    if (calls[i]!.fn === fn) return calls[i];
  }
  return undefined;
}
