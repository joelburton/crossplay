import { forwardRef, useEffect, useState } from "react";
import type { CSSProperties } from "react";
import type { Cell as CellT } from "@crossplay/shared";
import type { Cursor } from "../cursor";
import { Cell } from "./Cell";
import { RebusInput } from "./RebusInput";
import styles from "./Board.module.css";

type RebusProps = {
  initial: string;
  maxLength: number;
  onCommit: (value: string) => void;
  onCancel: () => void;
};

type Props = {
  cells: CellT[][];
  cursor: Cursor;
  highlighted: Set<string>;
  recentFills: Map<string, string>;
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
// `@media (max-width: 1023px)` rules in App.module.css and
// PuzzleView.module.css in sync (they're flagged with a comment).
export const NARROW_QUERY = "(max-width: 1023px)";
// In narrow mode the board fills the available width: viewport minus the
// .main 0.5rem L/R padding (= 1rem total) minus the board's 2x2px border.
const NARROW_HORIZ_RESERVE_CSS = "1rem + 4px";

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
 * In narrow viewports (max-width 1023px) the clue panels are hidden and
 * the board fills the available width minus the .main padding. Wide
 * viewports use a percentage of viewport width interpolated by puzzle
 * size (see `targetWidthPercent`).
 *
 * Forwards a ref to the outer grid element so PuzzleView can observe the
 * board's right edge for the chat indicator alignment.
 */
export const Board = forwardRef<HTMLDivElement, Props>(function Board(
  { cells, cursor, highlighted, recentFills, collapseRebus, onCellClick, rebus, zoom },
  ref,
) {
  const width = cells[0]?.length ?? 0;
  const height = cells.length;
  const narrow = useNarrowViewport();
  const horiz = narrow
    ? `calc((100vw - (${NARROW_HORIZ_RESERVE_CSS})) / ${width})`
    : `calc(${targetWidthPercent(width)}vw / ${width})`;
  const cellSize = `min(${horiz}, calc((100vh - ${VERTICAL_OVERHEAD_PX}px) / ${height}), ${MAX_CELL_PX}px)`;
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
              collapseRebus={collapseRebus}
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
