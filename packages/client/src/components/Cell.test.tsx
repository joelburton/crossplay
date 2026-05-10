// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { Cell as CellT } from "@crossplay/shared";
import { Cell } from "./Cell";

afterEach(() => cleanup());

function open(opts: Partial<CellT & { kind: "cell" }> = {}): CellT {
  return { kind: "cell", number: null, fill: null, ...opts } as CellT;
}

function renderCell(cell: CellT, props: Partial<Parameters<typeof Cell>[0]> = {}) {
  return render(
    <Cell
      cell={cell}
      row={0}
      col={0}
      isCursor={false}
      isInWord={false}
      recentColor={null}
      collapseRebus={false}
      onClick={() => {}}
      {...props}
    />,
  );
}

/** Extract the effective em value. Inline fontSize is
 *  `min(0.62em, Xem)`, which jsdom may simplify to `calc(Xem)` when
 *  one side dominates. Either way, the effective size is the smallest
 *  number that appears in the string. */
function shrunkEm(fontSize: string): number {
  const matches = [...fontSize.matchAll(/([\d.]+)em/g)].map((m) => Number(m[1]));
  if (matches.length === 0) throw new Error(`unexpected fontSize: ${fontSize}`);
  return Math.min(...matches);
}

describe("Cell rendering", () => {
  it("renders a block as an empty cell with no children", () => {
    const { container } = renderCell({ kind: "block" });
    const cell = container.firstChild as HTMLElement;
    expect(cell.textContent).toBe("");
  });

  it("does not set inline font-size for a single-letter fill", () => {
    const { container } = renderCell(open({ fill: "A" }));
    const span = container.querySelector("span:last-child") as HTMLElement;
    // .fill inherits the CSS module's 0.62em — no inline style needed
    // beyond the optional recentColor branch.
    expect(span.style.fontSize).toBe("");
  });

  it("shrinks a 3-char rebus below the single-char default", () => {
    const { container } = renderCell(open({ fill: "ABC" }));
    const span = container.querySelector("span:last-child") as HTMLElement;
    // 0.9 / 3 = 0.3em, well below the 0.62em default.
    expect(shrunkEm(span.style.fontSize)).toBeCloseTo(0.3, 3);
  });

  it("never falls below the 0.22em readable floor for very long rebuses", () => {
    // 0.9 / 8 = 0.1125em — without the floor this would be illegible.
    const { container } = renderCell(open({ fill: "ABCDEFGH" }));
    const span = container.querySelector("span:last-child") as HTMLElement;
    expect(shrunkEm(span.style.fontSize)).toBeGreaterThanOrEqual(0.22);
  });

  it("collapses a multi-char fill to its first letter when collapseRebus is on", () => {
    const { container } = renderCell(open({ fill: "BLOCK" }), { collapseRebus: true });
    const span = container.querySelector("span:last-child") as HTMLElement;
    expect(span.textContent).toBe("B");
    // Collapsed display is a single character — no shrink applied.
    expect(span.style.fontSize).toBe("");
  });

  it("does not collapse a single-letter fill (it's already one char)", () => {
    const { container } = renderCell(open({ fill: "A" }), { collapseRebus: true });
    const span = container.querySelector("span:last-child") as HTMLElement;
    expect(span.textContent).toBe("A");
  });

  it("renders a revealed triangle marker", () => {
    const { container } = renderCell(open({ fill: "A", revealed: true }));
    expect(container.querySelector('[aria-label="revealed"]')).toBeTruthy();
    expect(container.querySelector('[aria-label="wrong"]')).toBeNull();
  });

  it("renders a wrong triangle marker", () => {
    const { container } = renderCell(open({ fill: "A", wrong: true }));
    expect(container.querySelector('[aria-label="wrong"]')).toBeTruthy();
    expect(container.querySelector('[aria-label="revealed"]')).toBeNull();
  });

  it("applies recentColor as the fill text color (3s peer-flash)", () => {
    const { container } = renderCell(open({ fill: "A" }), { recentColor: "#1f77b4" });
    const span = container.querySelector("span:last-child") as HTMLElement;
    expect(span.style.color).toBe("rgb(31, 119, 180)");
  });

  it("renders the clue number when present", () => {
    const { container } = renderCell(open({ number: 7, fill: null }));
    expect(container.textContent).toContain("7");
  });
});
