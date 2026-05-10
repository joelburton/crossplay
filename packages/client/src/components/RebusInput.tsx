import { useEffect, useRef, useState } from "react";
import styles from "./Board.module.css";

type Props = {
  /** Pre-fill from the cell's current fill so editing an existing
   *  rebus doesn't force a re-type. */
  initial: string;
  /** Per-character cap; matches the server-side validator. */
  maxLength: number;
  onCommit: (value: string) => void;
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
          onCommit(value);
        } else if (e.key === "Escape") {
          e.preventDefault();
          onCancel();
        }
      }}
      onBlur={onCancel}
    />
  );
}
