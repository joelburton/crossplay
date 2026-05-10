import { memo } from "react";
import type { Cell as CellT } from "@crossplay/shared";
import styles from "./Cell.module.css";

type Props = {
  cell: CellT;
  row: number;
  col: number;
  isCursor: boolean;
  isInWord: boolean;
  onClick: (row: number, col: number) => void;
};

function CellImpl({ cell, row, col, isCursor, isInWord, onClick }: Props) {
  if (cell.kind === "block") {
    return <div className={`${styles.cell} ${styles.block}`} />;
  }
  const cls = [styles.cell];
  if (isCursor) cls.push(styles.cursor);
  else if (isInWord) cls.push(styles.inWord);
  return (
    <div className={cls.join(" ")} onClick={() => onClick(row, col)}>
      {cell.number != null && <span className={styles.number}>{cell.number}</span>}
      {cell.fill && <span className={styles.fill}>{cell.fill}</span>}
    </div>
  );
}

export const Cell = memo(CellImpl);
