import { useEffect, useRef } from "react";
import styles from "./HelpDialog.module.css";

type Props = {
  onClose: () => void;
};

const SHORTCUTS: Array<[string, string]> = [
  ["←↑→↓", "Move cursor (perpendicular arrow rotates direction)"],
  ["⇧←↑→↓", "Jump to word start / end (perpendicular flips direction)"],
  ["Tab / ⇧Tab", "Next / previous clue"],
  ["Letter", "Fill the current cell"],
  ["Backspace", "Erase and step back (clears a whole rebus in one press)"],
  ["⇧Backspace", "Clear the current word"],
  ["⇧Enter", "Open the rebus overlay over the focused cell"],
  ["Space", "Zoom-peek a multi-letter cell (read-only)"],
  ["|", "Cycle right-edge mark: break → hyphen → none"],
  ["_", "Cycle bottom-edge mark: break → hyphen → none"],
  ["/", "Open chat (or focus its input if already open)"],
  ["Esc (or `)", "Close chat / dialog"],
  ["⌥M", "Open the menu (arrows to navigate, Enter to choose)"],
  ["⌥P", "Toggle pen / pencil"],
  ["⌥N", "Show puzzle notes"],
  ["⌥S", "Open the shared scratchpad"],
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
            {/* Some keyboards don't print these glyphs, and the
                Alt/Option naming is a 40-year cross-platform
                disagreement — spell out both. Keep it inline so it
                sits right next to the table that uses the symbols. */}
            <p className={styles.legend}>
              <strong>⌥</strong> = Alt / Option key &nbsp;·&nbsp;{" "}
              <strong>⇧</strong> = Shift key
            </p>
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
            <h3>Word-break and hyphen marks</h3>
            <p>
              For cryptics whose enumerations specify multiple words or hyphens
              within a single grid entry (e.g. <em>(4,5)</em> or <em>(4-5)</em>), you
              can annotate the breaks on the grid. With the cursor on a cell, press{" "}
              <strong>|</strong> to cycle the right edge (none → break → hyphen →
              none) or <strong>_</strong> to cycle the bottom edge. A break is a
              thick line on the boundary; a hyphen is a short dash across it. Marks
              are shared with everyone solving the puzzle, and{" "}
              <em>Clear board</em> wipes them.
            </p>
          </section>
          <section>
            <h3>Cell markers</h3>
            <p>
              Some cells carry author-defined decoration. A{" "}
              <strong>circle</strong> or a <strong>shaded</strong> background marks a
              theme cell — both are visual only and don't affect solving. An{" "}
              <strong>underlined</strong> letter is a <em>given</em>: the author put
              it there and you can't change it. A handful of puzzles use{" "}
              <strong>Schrödinger</strong> cells, where the same square accepts more
              than one answer; Check will accept any of them, and Reveal writes the
              canonical one. Empty space at the puzzle's edges (or in interior cutouts)
              means the grid isn't rectangular — those squares aren't part of the
              puzzle, so the cursor and arrows skip past them.
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
