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

export function Board({ cells, cursor, highlighted, onCellClick }: Props) {
  const width = cells[0]?.length ?? 0;
  return (
    <div
      className={styles.board}
      style={{ gridTemplateColumns: `repeat(${width}, var(--cell-size))` }}
    >
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
