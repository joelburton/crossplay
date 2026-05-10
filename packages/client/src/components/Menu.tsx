import { useEffect, useRef } from "react";
import type { RefObject } from "react";
import type { PuzzleActions } from "../puzzleActions";
import styles from "./Menu.module.css";

type Props = {
  actions: PuzzleActions | null;
  triggerRef?: RefObject<HTMLElement>;
  onUploadAnother: () => void;
  onClose: () => void;
};

export function Menu({ actions, triggerRef, onUploadAnother, onClose }: Props) {
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
        <>
          <div className={styles.sep} role="separator" />
          <button type="button" className={styles.item} onClick={run(actions.revealLetter)}>
            Reveal letter
          </button>
          <button type="button" className={styles.item} onClick={run(actions.revealWord)}>
            Reveal word
          </button>
          <button type="button" className={styles.item} onClick={run(actions.revealPuzzle)}>
            Reveal puzzle
          </button>
          <div className={styles.sep} role="separator" />
          <button type="button" className={styles.item} onClick={run(actions.checkLetter)}>
            Check letter
          </button>
          <button type="button" className={styles.item} onClick={run(actions.checkWord)}>
            Check word
          </button>
          <button type="button" className={styles.item} onClick={run(actions.checkPuzzle)}>
            Check puzzle
          </button>
        </>
      )}
    </div>
  );
}
