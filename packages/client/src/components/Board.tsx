import type { CSSProperties } from "react";
import type { Cell as CellT } from "@crossplay/shared";
import type { Cursor } from "../cursor";
import { Cell } from "./Cell";
import styles from "./Board.module.css";

type Props = {
  cells: CellT[][];
  cursor: Cursor;
  highlighted: Set<string>;
  onCellClick: (row: number, col: number) => void;
};

// Reserved viewport height for header + paddings + gaps surrounding the board.
const VERTICAL_OVERHEAD_PX = 50;
// Sanity cap so cells don't get absurd on very large monitors.
const MAX_CELL_PX = 60;

function targetWidthPercent(width: number): number {
  // Linear interp: 40% at 15-col, 55% at 21-col, clamped at the endpoints.
  const pct = 40 + (width - 15) * (15 / 6);
  return Math.max(40, Math.min(55, pct));
}

export function Board({ cells, cursor, highlighted, onCellClick }: Props) {
  const width = cells[0]?.length ?? 0;
  const height = cells.length;
  const pct = targetWidthPercent(width);
  const cellSize = `min(calc(${pct}vw / ${width}), calc((100vh - ${VERTICAL_OVERHEAD_PX}px) / ${height}), ${MAX_CELL_PX}px)`;
  const style: CSSProperties = {
    fontSize: cellSize,
    gridTemplateColumns: `repeat(${width}, 1em)`,
  };
  return (
    <div className={styles.board} style={style}>
      {cells.flatMap((row, r) =>
        row.map((cell, c) => (
          <Cell
            key={`${r}:${c}`}
            cell={cell}
            row={r}
            col={c}
            isCursor={cursor.row === r && cursor.col === c}
            isInWord={highlighted.has(`${r}:${c}`)}
            onClick={onCellClick}
          />
        )),
      )}
    </div>
  );
}
