// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import type { Cell, PuzzleState } from "@crossplay/shared";
import type { Solution } from "./solution";

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

function makePuzzle(note = ""): PuzzleState {
  const cells: Cell[][] = [
    [cell(1), cell(2), cell(3)],
    [cell(4), cell(null), cell(null)],
    [cell(5), cell(null), cell(null)],
  ];
  return {
    meta: {
      id: "b1",
      title: "Solution Smoke",
      author: "Tester",
      copyright: "© 2026",
      note,
      width: 3,
      height: 3,
      clues: { across: [], down: [] },
    },
    snapshot: { version: 0, cells },
  };
}

function makeSolution(): Solution {
  return [
    [["A"], ["B"], ["C"]],
    [["D"], ["E"], ["F"]],
    [["G"], ["H"], ["I"]],
  ];
}

describe("generateSolutionPdf", () => {
  it("draws the title and fills every open cell with the solution letter", async () => {
    calls.length = 0;
    const { generateSolutionPdf } = await import("./solution");
    const blob = await generateSolutionPdf(makePuzzle(), makeSolution());
    expect(blob).toBeInstanceOf(Blob);

    const texts = calls.filter((c) => c.fn === "text").map((c) => c.args[0]);
    expect(texts).toContain("Solution Smoke");
    // Every solution letter is written to the grid.
    for (const letter of ["A", "B", "C", "D", "E", "F", "G", "H", "I"]) {
      expect(texts).toContain(letter);
    }
    // No clue headings on a solution PDF.
    expect(texts).not.toContain("ACROSS");
    expect(texts).not.toContain("DOWN");
  });

  it("draws note paragraphs into the clue regions when meta.note is set", async () => {
    calls.length = 0;
    const { generateSolutionPdf } = await import("./solution");
    const note = "Wordplay paragraph one.\n\nWordplay paragraph two.";
    await generateSolutionPdf(makePuzzle(note), makeSolution());
    const texts = calls.filter((c) => c.fn === "text").map((c) => c.args[0]);
    expect(texts).toContain("Wordplay paragraph one.");
    expect(texts).toContain("Wordplay paragraph two.");
  });

  it("emits a known set of text calls when meta.note is empty", async () => {
    calls.length = 0;
    const { generateSolutionPdf } = await import("./solution");
    await generateSolutionPdf(makePuzzle(""), makeSolution());
    const texts = calls.filter((c) => c.fn === "text").map((c) => String(c.args[0]));
    // Title block (title + author + copyright) and the nine solution
    // letters are drawn; no other strings should be present.
    const expected = new Set([
      "Solution Smoke",
      "Tester",
      "© 2026",
      "A", "B", "C", "D", "E", "F", "G", "H", "I",
      "1", "2", "3", "4", "5",
    ]);
    for (const t of texts) {
      expect(expected.has(t)).toBe(true);
    }
  });
});
