import { useEffect, useRef } from "react";
import type { RefObject } from "react";
import type { PuzzleActions } from "../puzzleActions";
import styles from "./Menu.module.css";

type Props = {
  actions: PuzzleActions | null;
  triggerRef?: RefObject<HTMLElement>;
  onUploadAnother: () => void;
  onShowNotes: () => void;
  onClose: () => void;
};

export function Menu({ actions, triggerRef, onUploadAnother, onShowNotes, onClose }: Props) {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    function onPointerDown(e: PointerEvent) {
      if (!(e.target instanceof Node)) return;
      if (ref.current?.contains(e.target)) return;
      if (triggerRef?.current?.contains(e.target)) return;
      onClose();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose, triggerRef]);

  function run(fn: (() => void) | undefined) {
    return () => {
      fn?.();
      onClose();
    };
  }

  return (
    <div ref={ref} className={styles.menu} role="menu">
      {actions && (
        <div className={styles.info}>
          <div className={styles.infoTitle}>{actions.meta.title || "Untitled"}</div>
          {actions.meta.author && (
            <div className={styles.infoAuthor}>by {actions.meta.author}</div>
          )}
        </div>
      )}
      <button type="button" className={styles.item} onClick={run(onUploadAnother)}>
        Upload another
      </button>
      {actions && (
        <button type="button" className={styles.item} onClick={run(actions.clearBoard)}>
          Clear board
        </button>
      )}
      {actions && (
        <button
          type="button"
          className={styles.item}
          onClick={run(onShowNotes)}
          disabled={!actions.meta.note}
        >
          Show notes
        </button>
      )}
      {actions && (
        <>
          <div className={styles.sep} role="separator" />
          <button type="button" className={styles.item} onClick={run(actions.revealLetter)}>
            <span>Reveal letter</span>
            <span className={styles.shortcut}>⌥R</span>
          </button>
          <button type="button" className={styles.item} onClick={run(actions.revealWord)}>
            <span>Reveal word</span>
            <span className={styles.shortcut}>⌥⇧R</span>
          </button>
          <button type="button" className={styles.item} onClick={run(actions.revealPuzzle)}>
            <span>Reveal puzzle</span>
          </button>
          <div className={styles.sep} role="separator" />
          <button type="button" className={styles.item} onClick={run(actions.checkLetter)}>
            <span>Check letter</span>
            <span className={styles.shortcut}>⌥C</span>
          </button>
          <button type="button" className={styles.item} onClick={run(actions.checkWord)}>
            <span>Check word</span>
            <span className={styles.shortcut}>⌥⇧C</span>
          </button>
          <button type="button" className={styles.item} onClick={run(actions.checkPuzzle)}>
            <span>Check puzzle</span>
          </button>
        </>
      )}
    </div>
  );
}
