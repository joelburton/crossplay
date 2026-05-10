import type { Mode } from "./PuzzleView";
import styles from "./ModeButton.module.css";

type Props = {
  mode: Mode;
  onToggle: () => void;
};

/**
 * Pen/pencil toggle button. Lives in the header next to the title so
 * it's always reachable while a puzzle is open. The mode itself lives
 * in App so this button can re-render on toggle without dragging
 * PuzzleView along.
 *
 * Mirror of the keyboard shortcut ⌥P. Pencil mode causes optimistic
 * fills to carry `pencil: true`, which the server stores and the cell
 * renders as italic gray; check operations skip pencil cells (server
 * also broadcasts a one-time warning when a check scope contained any).
 */
export function ModeButton({ mode, onToggle }: Props) {
  const title =
    mode === "pen"
      ? "In pen mode. Click for pencil. (⌥P)"
      : "In pencil mode. Click for pen. (⌥P)";
  return (
    <button
      type="button"
      className={`${styles.button} ${mode === "pen" ? styles.pen : styles.pencil}`}
      onClick={onToggle}
      title={title}
      aria-label={title}
      aria-pressed={mode === "pen"}
    >
      P
    </button>
  );
}
