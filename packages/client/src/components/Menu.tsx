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

/**
 * Dropdown menu anchored under the title. Opens on title click or via
 * the ⌥M global shortcut; closes on outside click, Escape, or after
 * firing any action.
 *
 * Keyboard navigation: ArrowDown/ArrowUp move focus through the
 * enabled buttons (wrapping at the ends); Home/End jump to first/last.
 * Tab is reserved globally for next-clue, so arrows are the only way
 * to traverse — the menu is small enough that this is fine. Enter and
 * Space activate the focused button natively. The first focusable item
 * is focused on mount.
 *
 * Action handlers are pulled from `actions` (a `PuzzleActions` ref —
 * see `puzzleActions.ts` for why it's a ref). When `actions` is null
 * (home page, no puzzle loaded) only "Return to main page" is shown. Disabled
 * states: "Show notes" greys out when the puzzle has no note text.
 */
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
      if (e.key === "Escape") {
        onClose();
        return;
      }
      // Arrow / Home / End navigation across the menu's enabled buttons.
      // We re-query on every press so newly-rendered items (or items
      // that flipped from disabled to enabled) participate without
      // having to track refs per row.
      const root = ref.current;
      if (!root) return;
      const all = Array.from(
        root.querySelectorAll<HTMLButtonElement>(`button.${styles.item}`),
      ).filter((b) => !b.disabled);
      if (all.length === 0) return;
      const idx = all.indexOf(document.activeElement as HTMLButtonElement);
      if (e.key === "ArrowDown") {
        e.preventDefault();
        const next = idx < 0 ? 0 : (idx + 1) % all.length;
        all[next]!.focus();
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        const next = idx < 0 ? all.length - 1 : (idx - 1 + all.length) % all.length;
        all[next]!.focus();
      } else if (e.key === "Home") {
        e.preventDefault();
        all[0]!.focus();
      } else if (e.key === "End") {
        e.preventDefault();
        all[all.length - 1]!.focus();
      }
    }
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose, triggerRef]);

  // Focus the first enabled button on mount so keyboard users can
  // start navigating immediately after ⌥M (or after clicking the
  // title). Pointer users who clicked don't notice the focus move.
  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    const first = root.querySelector<HTMLButtonElement>(
      `button.${styles.item}:not(:disabled)`,
    );
    first?.focus();
  }, []);

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
        Return to main page
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
          onClick={run(actions.toggleCollapseRebus)}
        >
          <span>{actions.collapseRebus ? "Show full rebuses" : "Collapse rebuses"}</span>
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
        <button type="button" className={styles.item} onClick={run(actions.openRebus)}>
          <span>Enter rebus</span>
          <span className={styles.shortcut}>⇧↵</span>
        </button>
      )}
      {actions && actions.openShare && (
        <button type="button" className={styles.item} onClick={run(actions.openShare)}>
          <span>Share with…</span>
        </button>
      )}
      {actions && (
        <button type="button" className={styles.item} onClick={run(actions.showHelp)}>
          <span>Help</span>
          <span className={styles.shortcut}>?</span>
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
          <div className={styles.sep} role="separator" />
          <button type="button" className={styles.item} onClick={run(actions.downloadIpuz)}>
            <span>Download as .ipuz</span>
          </button>
        </>
      )}
    </div>
  );
}
