import { memo } from "react";
import type { CSSProperties } from "react";
import type { Cell as CellT } from "@crossplay/shared";
import styles from "./Cell.module.css";

// Single-letter fills inherit the .fill class's 0.62em. Rebus fills
// shrink so the whole answer fits within the cell width. The factor
// (0.9em ÷ length) leaves a small margin so adjacent characters don't
// graze the cell edge; min() means a 1-char fill never grows past
// the default. Translate is dropped on multi-char so the text stays
// centered.
function fillStyle(fill: string, recentColor: string | null): CSSProperties | undefined {
  const multi = fill.length > 1;
  if (!multi && !recentColor) return undefined;
  const style: CSSProperties = {};
  if (recentColor) style.color = recentColor;
  if (multi) {
    style.fontSize = `min(0.62em, ${(0.9 / fill.length).toFixed(3)}em)`;
    style.transform = "none";
  }
  return style;
}

type Props = {
  cell: CellT;
  row: number;
  col: number;
  isCursor: boolean;
  isInWord: boolean;
  recentColor: string | null;
  /** When true, multi-character fills render as just their first
   *  letter (display only — the underlying fill is unchanged, and
   *  the rebus overlay still shows / commits the full string). */
  collapseRebus: boolean;
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
function CellImpl({ cell, row, col, isCursor, isInWord, recentColor, collapseRebus, onClick }: Props) {
  if (cell.kind === "block") {
    return <div className={`${styles.cell} ${styles.block}`} />;
  }
  const cls = [styles.cell];
  if (isCursor) cls.push(styles.cursor);
  else if (isInWord) cls.push(styles.inWord);
  // Display string: optionally collapse a rebus to its first letter
  // for legibility on small screens. Width math (font shrink) skips
  // the multi-char branch when the displayed string is one character.
  const displayed =
    cell.fill && collapseRebus && cell.fill.length > 1 ? cell.fill[0]! : cell.fill;
  return (
    <div className={cls.join(" ")} onClick={() => onClick(row, col)}>
      {cell.number != null && <span className={styles.number}>{cell.number}</span>}
      {cell.wrong ? (
        <span className={`${styles.mark} ${styles.wrong}`} aria-label="wrong" />
      ) : cell.revealed ? (
        <span className={`${styles.mark} ${styles.revealed}`} aria-label="revealed" />
      ) : null}
      {displayed && (
        <span
          className={`${styles.fill} ${cell.pencil ? styles.pencil : ""}`}
          style={fillStyle(displayed, recentColor)}
        >
          {displayed}
        </span>
      )}
    </div>
  );
}

export const Cell = memo(CellImpl);
