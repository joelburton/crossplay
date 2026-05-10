import type { Mode } from "./PuzzleView";
import styles from "./ModeButton.module.css";

type Props = {
  mode: Mode;
  onToggle: () => void;
};

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
