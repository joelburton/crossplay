import { useEffect, useRef, useState } from "react";
import styles from "./NumberJumpDialog.module.css";

type Props = {
  onSubmit: (n: number) => boolean;
  onClose: () => void;
};

/**
 * Small modal opened by `#`. Type a clue number, Enter to jump the
 * cursor to that numbered cell. Esc / click-outside / blank Enter
 * cancels. Invalid number shows an inline error and keeps focus in
 * the input.
 *
 * `onSubmit` returns true when the jump succeeded (we close), false
 * when the number isn't on the grid (we show the error and stay open).
 */
export function NumberJumpDialog({ onSubmit, onClose }: Props) {
  const [value, setValue] = useState("");
  const [error, setError] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const cardRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  function commit() {
    const trimmed = value.trim();
    if (!trimmed) {
      onClose();
      return;
    }
    const n = Number(trimmed);
    if (!Number.isInteger(n) || n <= 0 || !onSubmit(n)) {
      setError(true);
      return;
    }
    // onSubmit returned true; parent will unmount us.
  }

  function onKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      e.preventDefault();
      commit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    }
  }

  function onBackdropMouseDown(e: React.MouseEvent) {
    if (cardRef.current && !cardRef.current.contains(e.target as Node)) {
      onClose();
    }
  }

  return (
    <div className={styles.backdrop} onMouseDown={onBackdropMouseDown}>
      <div className={styles.card} ref={cardRef} role="dialog" aria-label="Jump to clue number">
        <div className={styles.body}>
          <div className={styles.label}>Jump to clue number</div>
          <input
            ref={inputRef}
            className={styles.input}
            type="text"
            inputMode="numeric"
            pattern="[0-9]*"
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              if (error) setError(false);
            }}
            onKeyDown={onKey}
            aria-label="Clue number"
            aria-invalid={error || undefined}
          />
          <div className={styles.error} aria-live="polite">
            {error ? "No cell with that number." : ""}
          </div>
        </div>
      </div>
    </div>
  );
}
