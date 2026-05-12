import { memo } from "react";
import type { CSSProperties } from "react";
import type { Cell as CellT } from "@crossplay/shared";
import styles from "./Cell.module.css";

// Single-letter fills inherit the .fill class's 0.62em. Rebus fills
// shrink so the whole answer fits within the cell width. The factor
// (0.9em ÷ length) leaves a small margin so adjacent characters don't
// graze the cell edge; min() means a 1-char fill never grows past
// the default; max() keeps long answers above a readable floor so
// they don't disappear into a pixel. Long rebuses are still hard to
// read at rest — use Space (peek) or the collapse-rebuses preference
// to see them full size. Translate is dropped on multi-char so the
// text stays centered.
const REBUS_MIN_EM = 0.22;
function fillStyle(fill: string, recentColor: string | null): CSSProperties | undefined {
  const multi = fill.length > 1;
  if (!multi && !recentColor) return undefined;
  const style: CSSProperties = {};
  if (recentColor) style.color = recentColor;
  if (multi) {
    const fit = Math.max(REBUS_MIN_EM, 0.9 / fill.length);
    style.fontSize = `min(0.62em, ${fit.toFixed(3)}em)`;
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
  /** When set, render a thin inset frame in this color — a remote
   *  player's cursor is on this cell. Visually distinct from the local
   *  cursor (yellow background). Coexists with `isCursor` if a peer
   *  happens to land on the same cell. */
  remoteCursorColor: string | null;
  /** When true, multi-character fills render as just their first
   *  letter (display only — the underlying fill is unchanged, and
   *  the rebus overlay still shows / commits the full string). */
  collapseRebus: boolean;
  /** Bitmask of which sides need a black border (BORDER_TOP/RIGHT/
   *  BOTTOM/LEFT from cursor.ts, OR'd together). Computed in Board
   *  from the static cell shape; stable for the lifetime of a puzzle
   *  so React.memo's shallow compare keeps cells from re-rendering. */
  borderMask: number;
  onClick: (row: number, col: number) => void;
};

function borderClasses(mask: number): string {
  const parts: (string | undefined)[] = [];
  if (mask & 8) parts.push(styles.borderTop);
  if (mask & 4) parts.push(styles.borderRight);
  if (mask & 2) parts.push(styles.borderBottom);
  if (mask & 1) parts.push(styles.borderLeft);
  return parts.filter(Boolean).join(" ");
}

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
function CellImpl({
  cell,
  row,
  col,
  isCursor,
  isInWord,
  recentColor,
  remoteCursorColor,
  collapseRebus,
  borderMask,
  onClick,
}: Props) {
  if (cell.kind === "block") {
    // Borders close the puzzle's outline; the cell's own background
    // (black for a regular block, white for a hidden null) carries
    // the rest of the visual. Hidden cells skip the .block class so
    // they stay white.
    const kindClass = cell.hidden ? styles.voidCell : styles.block;
    return <div className={`${styles.cell} ${kindClass} ${borderClasses(borderMask)}`} />;
  }
  const cls = [styles.cell, borderClasses(borderMask)];
  if (isCursor) cls.push(styles.cursor);
  else if (isInWord) cls.push(styles.inWord);
  // Mark overlays: rendered as absolutely-positioned spans further
  // down so they sit over both the cell background and any cursor/
  // in-word highlight tint, but underneath the clue number.
  const markRight = cell.markRight;
  const markBottom = cell.markBottom;
  // Display string: optionally collapse a rebus to its first letter
  // for legibility on small screens. Width math (font shrink) skips
  // the multi-char branch when the displayed string is one character.
  const displayed =
    cell.fill && collapseRebus && cell.fill.length > 1 ? cell.fill[0]! : cell.fill;
  return (
    <div className={cls.join(" ")} onClick={() => onClick(row, col)}>
      {cell.shaded && <span className={styles.shade} aria-hidden />}
      {cell.circled && <span className={styles.circle} aria-hidden />}
      {markRight === "break" && <span className={styles.markRightBreak} aria-hidden />}
      {markRight === "hyphen" && <span className={styles.markRightHyphen} aria-hidden />}
      {markBottom === "break" && <span className={styles.markBottomBreak} aria-hidden />}
      {markBottom === "hyphen" && <span className={styles.markBottomHyphen} aria-hidden />}
      {remoteCursorColor && (
        // Absolutely-positioned overlay with a per-side border. We used
        // to do `box-shadow: inset 0 0 0 0.08em color` here, but
        // box-shadow round-tripped through subpixel rendering can paint
        // the left edge a hair thicker than the others at some zoom
        // levels. Border widths are laid out per-side, so this is
        // visually symmetric. `pointer-events: none` keeps clicks on
        // the cell.
        <span
          className={styles.remoteFrame}
          style={{ borderColor: remoteCursorColor }}
          aria-hidden
        />
      )}
      {cell.number != null && <span className={styles.number}>{cell.number}</span>}
      {cell.wrong ? (
        <span className={`${styles.mark} ${styles.wrong}`} aria-label="wrong" />
      ) : cell.revealed ? (
        <span className={`${styles.mark} ${styles.revealed}`} aria-label="revealed" />
      ) : null}
      {displayed && (
        <span
          className={[
            styles.fill,
            cell.pencil ? styles.pencil : "",
            cell.given ? styles.given : "",
          ].filter(Boolean).join(" ")}
          style={fillStyle(displayed, recentColor)}
        >
          {displayed}
        </span>
      )}
    </div>
  );
}

export const Cell = memo(CellImpl);
