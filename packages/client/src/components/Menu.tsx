import { useEffect, useRef } from "react";
import type { RefObject } from "react";
import pkg from "../../package.json";
import type { PuzzleActions } from "../puzzleActions";
import styles from "./Menu.module.css";

const VERSION = pkg.version;

type Props = {
  actions: PuzzleActions | null;
  triggerRef?: RefObject<HTMLElement>;
  onNewGame: () => void;
  onClose: () => void;
};

export function Menu({ actions, triggerRef, onNewGame, onClose }: Props) {
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
      <div className={styles.brand}>Crossplay v{VERSION}</div>
      {actions && (
        <div className={styles.info}>
          <div className={styles.infoTitle}>{actions.meta.title || "Untitled"}</div>
          {actions.meta.author && (
            <div className={styles.infoAuthor}>by {actions.meta.author}</div>
          )}
          {actions.meta.copyright && (
            <div className={styles.infoAuthor}>{actions.meta.copyright}</div>
          )}
        </div>
      )}
      <button type="button" className={styles.item} onClick={run(onNewGame)}>
        New game
      </button>
      {actions && (
        <button type="button" className={styles.item} onClick={run(actions.clearBoard)}>
          Clear board
        </button>
      )}
      {actions && (
        <button type="button" className={styles.item} onClick={run(actions.togglePencil)}>
          <span>Switch to {actions.mode === "pen" ? "pencil" : "pen"}</span>
          <span className={styles.shortcut}>⌥P</span>
        </button>
      )}
      {actions && (
        <button
          type="button"
          className={styles.item}
          onClick={run(actions.showNotes)}
          disabled={!actions.meta.note}
        >
          <span>Show notes</span>
          <span className={styles.shortcut}>⌥N</span>
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
