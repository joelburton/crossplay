import { forwardRef, useEffect, useState } from "react";
import type { CSSProperties } from "react";
import type { Cell as CellT } from "@crossplay/shared";
import type { Cursor } from "../cursor";
import { Cell } from "./Cell";
import styles from "./Board.module.css";

type Props = {
  cells: CellT[][];
  cursor: Cursor;
  highlighted: Set<string>;
  recentFills: Map<string, string>;
  onCellClick: (row: number, col: number) => void;
};

// Reserved viewport height for header + paddings + gaps surrounding the board.
const VERTICAL_OVERHEAD_PX = 50;
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
  { cells, cursor, highlighted, recentFills, onCellClick },
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
              onClick={onCellClick}
            />
          );
        }),
      )}
    </div>
  );
});
