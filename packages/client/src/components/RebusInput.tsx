import { useEffect, useRef, useState } from "react";
import styles from "./Board.module.css";

/** What the parent should do *after* writing the committed rebus
 *  value. "advance" (the Enter case) moves one cell in the cursor's
 *  current direction, stopping at word boundaries — same as typing a
 *  letter. "jumpNext"/"jumpPrev" (Tab / Shift+Tab) jumps to the next
 *  or previous clue, mirroring Tab's behavior elsewhere in the app.
 *  Mirrored on the parent (`onRebusCommit` in PuzzleView). */
export type RebusPostCommit = "advance" | "jumpNext" | "jumpPrev";

type Props = {
  /** Pre-fill from the cell's current fill so editing an existing
   *  rebus doesn't force a re-type. */
  initial: string;
  /** Per-character cap; matches the server-side validator. */
  maxLength: number;
  /** Commit the typed value. `post` tells the parent what to do with
   *  the cursor afterward — Enter advances one cell, Tab/⇧Tab jumps
   *  to the next/previous clue. */
  onCommit: (value: string, post: RebusPostCommit) => void;
  onCancel: () => void;
};

/**
 * Inline overlay for entering a rebus answer. Stays self-contained:
 * owns its own value state, autofocuses on mount, commits on Enter,
 * cancels on Esc/blur. The parent (PuzzleView via Board) only learns
 * the final string — typing is local.
 *
 * The PuzzleView keystroke handler bails out when an INPUT has focus,
 * so opening this overlay automatically suspends grid navigation
 * without coordination. Position + sizing come from the wrapping div
 * Board renders; this component only fills its container.
 */
export function RebusInput({ initial, maxLength, onCommit, onCancel }: Props) {
  const [value, setValue] = useState(initial);
  const ref = useRef<HTMLInputElement>(null);
  // Enter -> onCommit unmounts this input via parent state, which
  // fires blur during DOM removal. Without this guard, onBlur would
  // also call onCancel — harmless today because onCancel is
  // idempotent, but a trap if onCancel ever grows side effects.
  const committedRef = useRef(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.select();
  }, []);

  return (
    <input
      ref={ref}
      className={styles.rebus}
      value={value}
      maxLength={maxLength}
      // aria-label keeps the field reachable for assistive tech without
      // adding visible chrome around the cell.
      aria-label="Rebus entry"
      onChange={(e) => {
        const cleaned = e.target.value.replace(/[^a-zA-Z]/g, "").slice(0, maxLength).toUpperCase();
        setValue(cleaned);
      }}
      onKeyDown={(e) => {
        // Stop bubbling so PuzzleView's window keydown handler doesn't
        // also act on our keys (it bails on INPUT targets, but
        // stopPropagation is belt-and-braces for any future handler).
        e.stopPropagation();
        if (e.key === "Enter") {
          e.preventDefault();
          committedRef.current = true;
          onCommit(value, "advance");
        } else if (e.key === "Tab") {
          // Tab commits the current value AND jumps to the next clue
          // (Shift+Tab to the previous), mirroring Tab's behavior
          // elsewhere on the board. preventDefault stops the browser's
          // own focus-move; the parent will close the rebus and
          // jumpClue, so focus naturally returns to the board.
          e.preventDefault();
          committedRef.current = true;
          onCommit(value, e.shiftKey ? "jumpPrev" : "jumpNext");
        } else if (e.key === "Escape") {
          e.preventDefault();
          onCancel();
        }
      }}
      onBlur={() => {
        if (committedRef.current) return;
        onCancel();
      }}
    />
  );
}
