import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parsePuzBuffer } from "./puzzle.js";

const FIXTURE = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
  "a-very-moth-puzzle.puz",
);

describe("parsePuzBuffer", () => {
  const buffer = readFileSync(FIXTURE);
  const { state, solution } = parsePuzBuffer("test-id", buffer);

  it("snapshot grid matches reported dimensions", () => {
    expect(state.meta.width).toBeGreaterThan(0);
    expect(state.meta.height).toBeGreaterThan(0);
    expect(state.snapshot.cells).toHaveLength(state.meta.height);
    for (const row of state.snapshot.cells) {
      expect(row).toHaveLength(state.meta.width);
    }
  });

  it("uses the provided id", () => {
    expect(state.meta.id).toBe("test-id");
  });

  it("starts at version 0 with no fills", () => {
    expect(state.snapshot.version).toBe(0);
    const fills = state.snapshot.cells.flat().filter((c) => c.kind === "cell" && c.fill != null);
    expect(fills).toHaveLength(0);
  });

  it("returns clues for both directions", () => {
    expect(state.meta.clues.across.length).toBeGreaterThan(0);
    expect(state.meta.clues.down.length).toBeGreaterThan(0);
  });

  it("numbers cells consistently with clue list", () => {
    const numbers = new Set<number>();
    for (const row of state.snapshot.cells) {
      for (const cell of row) {
        if (cell.kind === "cell" && cell.number != null) numbers.add(cell.number);
      }
    }
    for (const clue of state.meta.clues.across) {
      expect(numbers.has(clue.number)).toBe(true);
    }
    for (const clue of state.meta.clues.down) {
      expect(numbers.has(clue.number)).toBe(true);
    }
  });

  it("numbers in increasing left-to-right, top-to-bottom order", () => {
    let last = 0;
    for (const row of state.snapshot.cells) {
      for (const cell of row) {
        if (cell.kind === "cell" && cell.number != null) {
          expect(cell.number).toBe(last + 1);
          last = cell.number;
        }
      }
    }
  });

  it("returns a solution grid the same shape as the snapshot", () => {
    expect(solution).toHaveLength(state.meta.height);
    expect(solution[0]).toHaveLength(state.meta.width);
  });

  it("solution has letters where snapshot has cells, null where blocks", () => {
    for (let r = 0; r < state.meta.height; r++) {
      for (let c = 0; c < state.meta.width; c++) {
        const cell = state.snapshot.cells[r]![c]!;
        const sol = solution[r]![c];
        if (cell.kind === "block") expect(sol).toBeNull();
        else expect(sol).toMatch(/^[A-Z]$/);
      }
    }
  });
});
