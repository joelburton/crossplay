import { memo } from "react";
import type { Cell as CellT } from "@crossplay/shared";
import styles from "./Cell.module.css";

type Props = {
  cell: CellT;
  row: number;
  col: number;
  isCursor: boolean;
  isInWord: boolean;
  recentColor: string | null;
  onClick: (row: number, col: number) => void;
};

/**
 * One grid cell. Pure and memoized — re-renders only when its props
 * change, which keeps typing fast on large grids.
 *
 * Renders one of:
 *  - a black block (cell.kind === "block");
 *  - an empty white cell with optional clue number, optional fill letter
 *    (pen or pencil styled), and an optional triangle marker in the
 *    top-right corner (red for `wrong`, blue for `revealed`).
 *
 * `recentColor` is the 3-second flash color shown when *another* player
 * fills this cell; PuzzleView clears it on a per-cell timer.
 */
function CellImpl({ cell, row, col, isCursor, isInWord, recentColor, onClick }: Props) {
  if (cell.kind === "block") {
    return <div className={`${styles.cell} ${styles.block}`} />;
  }
  const cls = [styles.cell];
  if (isCursor) cls.push(styles.cursor);
  else if (isInWord) cls.push(styles.inWord);
  return (
    <div className={cls.join(" ")} onClick={() => onClick(row, col)}>
      {cell.number != null && <span className={styles.number}>{cell.number}</span>}
      {cell.wrong ? (
        <span className={`${styles.mark} ${styles.wrong}`} aria-label="wrong" />
      ) : cell.revealed ? (
        <span className={`${styles.mark} ${styles.revealed}`} aria-label="revealed" />
      ) : null}
      {cell.fill && (
        <span
          className={`${styles.fill} ${cell.pencil ? styles.pencil : ""}`}
          style={recentColor ? { color: recentColor } : undefined}
        >
          {cell.fill}
        </span>
      )}
    </div>
  );
}

export const Cell = memo(CellImpl);
