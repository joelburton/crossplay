import { useEffect, useRef } from "react";
import styles from "./HelpDialog.module.css";

type Props = {
  onClose: () => void;
};

const SHORTCUTS: Array<[string, string]> = [
  ["←↑→↓", "Move cursor (perpendicular arrow rotates direction)"],
  ["Tab / ⇧Tab", "Next / previous clue"],
  ["Letter", "Fill the current cell"],
  ["Backspace", "Erase and step back (clears a whole rebus in one press)"],
  ["⇧Enter", "Open the rebus overlay over the focused cell"],
  ["Space", "Zoom-peek a multi-letter cell (read-only)"],
  ["/", "Open chat (or focus its input if already open)"],
  ["Esc", "Close chat"],
  ["⌥P", "Toggle pen / pencil"],
  ["⌥N", "Show puzzle notes"],
  ["⌥R / ⌥⇧R", "Reveal letter / word"],
  ["⌥C / ⌥⇧C", "Check letter / word"],
  ["#", "Jump to a clue number"],
  ["?", "Open this help"],
];

export function HelpDialog({ onClose }: Props) {
  const cardRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  function onBackdropClick(e: React.MouseEvent) {
    if (cardRef.current && !cardRef.current.contains(e.target as Node)) {
      onClose();
    }
  }

  return (
    <div className={styles.backdrop} onMouseDown={onBackdropClick}>
      <div className={styles.card} ref={cardRef} role="dialog" aria-label="Help">
        <header className={styles.header}>
          <h2 className={styles.title}>Help</h2>
          <button type="button" className={styles.close} onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>
        <div className={styles.body}>
          <section>
            <h3>Keyboard shortcuts</h3>
            <table className={styles.shortcuts}>
              <tbody>
                {SHORTCUTS.map(([keys, desc]) => (
                  <tr key={keys}>
                    <td>{keys}</td>
                    <td>{desc}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
          <section>
            <h3>Pen vs pencil</h3>
            <p>
              Pen is for letters you're sure of; pencil is for guesses. Toggle with{" "}
              <strong>⌥P</strong> or the <strong>P</strong> button in the header. Pencil
              cells show a small triangle marker. <strong>Check</strong> skips pencil
              cells (it won't tell you a guess is wrong), and <strong>Reveal</strong>{" "}
              upgrades the revealed cell from pencil to pen.
            </p>
          </section>
          <section>
            <h3>What's a rebus?</h3>
            <p>
              A rebus is a cell that holds more than one letter — common in themed
              puzzles where a single square stands for a whole word or phrase (e.g. a
              square containing <strong>HEART</strong>). Press <strong>⇧Enter</strong>{" "}
              to open the multi-letter input over the current cell, type your answer,
              and press <strong>Enter</strong> to commit (<strong>Esc</strong>{" "}
              cancels). Use <strong>Space</strong> on a rebus cell to zoom in if it's
              hard to read. The menu's <em>Collapse rebuses</em> toggle shrinks them
              to their first letter while keeping the full answer underneath.
            </p>
          </section>
          <section>
            <h3>Playing together</h3>
            <p>
              Anyone with the URL can play and chat — there are no accounts. Each
              player picks a color (or gets one assigned); fills from other players
              briefly flash in that color. Click <em>Show notes</em> to open the
              puzzle's note for everyone at once.
            </p>
          </section>
        </div>
      </div>
    </div>
  );
}
