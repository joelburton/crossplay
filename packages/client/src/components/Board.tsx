import { useEffect, useState } from "react";
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
// Must match the breakpoint in PuzzleView.module.css that hides .clues.
const NARROW_QUERY = "(max-width: 1023px)";
// When clues are hidden the board can take essentially the whole width.
const NARROW_PCT = 92;

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

export function Board({ cells, cursor, highlighted, recentFills, onCellClick }: Props) {
  const width = cells[0]?.length ?? 0;
  const height = cells.length;
  const narrow = useNarrowViewport();
  const pct = narrow ? NARROW_PCT : targetWidthPercent(width);
  const cellSize = `min(calc(${pct}vw / ${width}), calc((100vh - ${VERTICAL_OVERHEAD_PX}px) / ${height}), ${MAX_CELL_PX}px)`;
  const style: CSSProperties = {
    fontSize: cellSize,
    gridTemplateColumns: `repeat(${width}, 1em)`,
  };
  return (
    <div className={styles.board} style={style}>
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
}
