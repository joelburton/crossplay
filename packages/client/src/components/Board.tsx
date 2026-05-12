import { forwardRef, useEffect, useMemo, useState } from "react";
import type { CSSProperties } from "react";
import type { Cell as CellT } from "@crossplay/shared";
import { computeBorderMask, type Cursor } from "../cursor";
import { Cell } from "./Cell";
import { RebusInput } from "./RebusInput";
import styles from "./Board.module.css";

type RebusProps = {
  initial: string;
  maxLength: number;
  onCommit: (value: string, post: "advance" | "jumpNext" | "jumpPrev") => void;
  onCancel: () => void;
};

type Props = {
  cells: CellT[][];
  cursor: Cursor;
  highlighted: Set<string>;
  recentFills: Map<string, string>;
  /** Per-cell remote-cursor color (key = `${row}:${col}`). Cells with
   *  an entry render a thin colored frame in that color. PuzzleView
   *  builds this from the live presence map; first-seen wins on cell
   *  collisions. */
  remoteCursorByCell: Map<string, string>;
  /** Display-only: when true, multi-character (rebus) fills render as
   *  just their first letter so they're legible on small screens. The
   *  underlying fill is unchanged. */
  collapseRebus: boolean;
  onCellClick: (row: number, col: number) => void;
  /** When set, Board renders an inline rebus input overlaid on the
   *  cursor cell. Position is computed from `cursor` + the inline
   *  font-size (em units track the cell exactly). */
  rebus?: RebusProps | null;
  /** When set, Board renders a non-editable zoom-peek of the cell's
   *  fill in the same overlay box. Shown while the user holds / has
   *  pressed space; dismissed by any other handled keystroke. Mutually
   *  exclusive with `rebus` (typing always wins over peeking). */
  zoom?: string | null;
};

// Reserved viewport height for header + paddings + gaps surrounding
// the board. Measured at ~56px (header ~42px + .main top/bottom
// padding ~14px); we round up a touch so there's a tiny visible
// bottom margin instead of flush-to-the-edge (which used to scroll a
// few pixels on heights where the cell calc was the binding term).
const VERTICAL_OVERHEAD_PX = 64;
// Sanity cap so cells don't get absurd on very large monitors.
const MAX_CELL_PX = 60;
// Re-export so PuzzleView and any future narrow-mode code use the same
// query string. CSS modules can't read this directly — keep the
// `@media (max-width: 1024px)` rules in App.module.css and
// PuzzleView.module.css in sync (they're flagged with a comment). The
// 1024px cut is one wider than Tailwind's `lg:` default so iPads in
// landscape (exactly 1024×768) land in narrow mode, matching the
// platform-priority list in CLAUDE.md ("tablets with a hardware
// keyboard → same as narrow-window mode").
export const NARROW_QUERY = "(max-width: 1024px)";
// In narrow mode the board fills the available width: viewport minus the
// .main 0.5rem L/R padding (= 1rem total) minus the board's 2x2px border.
const NARROW_HORIZ_RESERVE_CSS = "1rem + 4px";
// The active clue sits below the board on every viewport (PuzzleView's
// `.activeClue` strip). The cell-size height bound has to subtract
// that strip, or the board would spill into it. Approximate height:
// 3 lines at 1.35 × 1.05rem font-size + 0.3rem top padding ≈ 73px.
// Keep this loosely aligned with the `.activeClue` `min-height` in
// PuzzleView.module.css so the fit-on-screen math is conservative
// (better a few px short than to force an outer scrollbar).
const ACTIVE_CLUE_RESERVE_PX = 76;

// Width of the rebus overlay, in cell-widths. Wider than one cell so
// the player can see the whole rebus they're typing without text
// being clipped at the cell edge.
const REBUS_WIDTH_EM = 3;

/** Position the overlay box centered horizontally on the cursor cell,
 *  clamped to stay within the grid's columns. Top is exactly the
 *  cursor row, width spans REBUS_WIDTH_EM cells, height is one cell. */
function rebusWrapStyle(row: number, col: number, gridWidth: number): CSSProperties {
  const idealLeft = col + 0.5 - REBUS_WIDTH_EM / 2;
  const maxLeft = gridWidth - REBUS_WIDTH_EM;
  const left = Math.max(0, Math.min(maxLeft, idealLeft));
  return {
    top: `${row}em`,
    left: `${left}em`,
    width: `${REBUS_WIDTH_EM}em`,
    height: "1em",
  };
}

function targetWidthPercent(width: number): number {
  // Linear interp: 40% at 15-col, 55% at 21-col, clamped at the endpoints.
  const pct = 40 + (width - 15) * (15 / 6);
  return Math.max(40, Math.min(55, pct));
}

function useNarrowViewport(): boolean {
  const [narrow, setNarrow] = useState(
    () => typeof window !== "undefined" && window.matchMedia(NARROW_QUERY).matches,
  );
  useEffect(() => {
    const mq = window.matchMedia(NARROW_QUERY);
    const onChange = (e: MediaQueryListEvent) => setNarrow(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return narrow;
}

/**
 * Renders the crossword grid. Sizes itself by computing a single cell
 * dimension and applying it as inline `font-size`; every child uses `em`
 * units so the whole grid scales uniformly under both Chrome page-zoom
 * and Safari text-only-zoom (see CLAUDE.md "Cell sizing").
 *
 * In narrow viewports (max-width 1024px) the clue panels are hidden and
 * the board fills the available width minus the .main padding. Wide
 * viewports use a percentage of viewport width interpolated by puzzle
 * size (see `targetWidthPercent`).
 *
 * Forwards a ref to the outer grid element so PuzzleView can observe the
 * board's right edge for the chat indicator alignment.
 */
export const Board = forwardRef<HTMLDivElement, Props>(function Board(
  { cells, cursor, highlighted, recentFills, remoteCursorByCell, collapseRebus, onCellClick, rebus, zoom },
  ref,
) {
  const width = cells[0]?.length ?? 0;
  const height = cells.length;
  // Per-cell border bitmask. Computed once per `cells` reference (the
  // shape is fixed for the puzzle, so this is effectively per-puzzle).
  // Each entry is a 0–15 number; Cell receives it as a single
  // primitive prop so React.memo's shallow compare doesn't break.
  const borderMasks = useMemo(() => {
    const out: number[][] = [];
    for (let r = 0; r < cells.length; r++) {
      const row: number[] = [];
      for (let c = 0; c < (cells[r]?.length ?? 0); c++) {
        row.push(computeBorderMask(cells, r, c));
      }
      out.push(row);
    }
    return out;
  }, [cells]);
  const narrow = useNarrowViewport();
  const horiz = narrow
    ? `calc((100vw - (${NARROW_HORIZ_RESERVE_CSS})) / ${width})`
    : `calc(${targetWidthPercent(width)}vw / ${width})`;
  const verticalReservePx = VERTICAL_OVERHEAD_PX + ACTIVE_CLUE_RESERVE_PX;
  // 100dvh, not 100vh — on iOS Safari the dynamic viewport excludes
  // the URL bar / bottom toolbar; `100vh` would size cells assuming
  // those bars weren't there and push the board off-screen.
  const cellSize = `min(${horiz}, calc((100dvh - ${verticalReservePx}px) / ${height}), ${MAX_CELL_PX}px)`;
  const style: CSSProperties = {
    fontSize: cellSize,
    gridTemplateColumns: `repeat(${width}, 1em)`,
  };
  return (
    <div ref={ref} className={styles.board} style={style}>
      {cells.flatMap((row, r) =>
        row.map((cell, c) => {
          const key = `${r}:${c}`;
          return (
            <Cell
              key={key}
              cell={cell}
              row={r}
              col={c}
              isCursor={cursor.row === r && cursor.col === c}
              isInWord={highlighted.has(key)}
              recentColor={recentFills.get(key) ?? null}
              remoteCursorColor={remoteCursorByCell.get(key) ?? null}
              collapseRebus={collapseRebus}
              borderMask={borderMasks[r]![c]!}
              onClick={onCellClick}
            />
          );
        }),
      )}
      {rebus ? (
        // The wrapper carries the position (em units, evaluated at the
        // board's font-size). The input inside shrinks its own type
        // independently — if we put position on the input directly its
        // smaller font-size would scale top/left and the overlay would
        // land far from the cursor cell.
        <div
          className={styles.rebusWrap}
          style={rebusWrapStyle(cursor.row, cursor.col, width)}
        >
          <RebusInput
            initial={rebus.initial}
            maxLength={rebus.maxLength}
            onCommit={rebus.onCommit}
            onCancel={rebus.onCancel}
          />
        </div>
      ) : zoom ? (
        // Read-only peek of the cell's fill. Same overlay box as the
        // rebus input but rendered as a non-interactive div so arrows /
        // tab / letter keys keep flowing to PuzzleView's window handler.
        <div
          className={styles.rebusWrap}
          style={rebusWrapStyle(cursor.row, cursor.col, width)}
          aria-hidden
        >
          <div className={`${styles.rebus} ${styles.rebusReadonly}`}>{zoom}</div>
        </div>
      ) : null}
    </div>
  );
});
