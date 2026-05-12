/**
 * Compute a board's "percent filled" for the home-page meta line.
 *
 * Returns null when the live snapshot deep-equals the initial snapshot
 * (i.e. no player has touched the board yet — the home page renders
 * this as "NEW"). Otherwise returns floor(filled / fillable * 100),
 * where "filled" means any non-block cell with a non-empty fill.
 *
 * Correctness is intentionally ignored — see `project_optimistic_typing`
 * and the homepage sprint plan. Showing 100% for a fully-filled-but-
 * wrong board is by design; "DONE" / completion is a future feature.
 */

import type { GridSnapshot } from "@crossplay/shared";

export function computeFillPercent(
  initial: GridSnapshot,
  current: GridSnapshot,
): number | null {
  if (snapshotsEqual(initial, current)) return null;

  let filled = 0;
  let fillable = 0;
  for (const row of current.cells) {
    for (const cell of row) {
      if (cell.kind !== "cell") continue;
      // Givens are author-prefilled — not part of the player's work,
      // so neither counted as fillable nor as filled. A puzzle made
      // entirely of givens (degenerate, but possible) collapses to
      // fillable = 0 → null below.
      if (cell.given) continue;
      fillable++;
      if (cell.fill && cell.fill.length > 0) filled++;
    }
  }
  if (fillable === 0) return null;
  return Math.floor((filled / fillable) * 100);
}

/** Structural equality on the cell grid. Version differences are
 *  ignored — we care whether the player has typed anything, not whether
 *  the snapshot version counter has advanced (reveals/checks bump it
 *  without necessarily changing letters). */
function snapshotsEqual(a: GridSnapshot, b: GridSnapshot): boolean {
  if (a.cells.length !== b.cells.length) return false;
  for (let r = 0; r < a.cells.length; r++) {
    const rowA = a.cells[r]!;
    const rowB = b.cells[r]!;
    if (rowA.length !== rowB.length) return false;
    for (let c = 0; c < rowA.length; c++) {
      if (!cellsEqual(rowA[c]!, rowB[c]!)) return false;
    }
  }
  return true;
}

function cellsEqual(a: GridSnapshot["cells"][number][number], b: GridSnapshot["cells"][number][number]): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "block") {
    if (b.kind !== "block") return false;
    return !!a.hidden === !!b.hidden;
  }
  if (b.kind !== "cell") return false;
  return (
    a.number === b.number &&
    a.fill === b.fill &&
    !!a.revealed === !!b.revealed &&
    !!a.wrong === !!b.wrong &&
    !!a.pencil === !!b.pencil &&
    !!a.circled === !!b.circled &&
    !!a.shaded === !!b.shaded &&
    !!a.given === !!b.given &&
    (a.markRight ?? null) === (b.markRight ?? null) &&
    (a.markBottom ?? null) === (b.markBottom ?? null)
  );
}
