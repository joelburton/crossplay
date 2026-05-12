import { useEffect, useRef } from "react";
import styles from "./SolvedDialog.module.css";

type Props = {
  /** Dismiss the dialog and stay on the board. */
  onClose: () => void;
  /** Save + go back to the home page (new game). */
  onNewGame: () => void;
};

// A handful of festive glyphs the keyframes animate in. Mixed sizes
// and rotations keep the cluster feeling chaotic rather than tidy.
const CONFETTI = ["🎉", "🎊", "✨", "🥳", "🎈", "⭐"];

/**
 * Celebratory modal that pops on the server's `puzzleSolved`
 * broadcast. Two actions: "Play a new game" (saves + routes home) or
 * "Keep looking" (dismiss; the player can admire the solved grid).
 *
 * Esc dismisses; the backdrop is deliberately NOT click-to-close, so
 * a stray click at the moment of solving can't accidentally cancel the
 * celebration. Focus moves to the primary action on mount so a
 * keyboard player can Enter / Tab their way through the choice.
 */
export function SolvedDialog({ onClose, onNewGame }: Props) {
  const primaryRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    primaryRef.current?.focus();
    // Play the jingle. The dialog mounts in response to a WebSocket
    // message that itself was triggered by user input (typing the
    // last letter / picking Reveal), so most browsers count us as
    // within the user-gesture window and allow it. Safari is the
    // strictest — if it rejects, swallow silently so the visual
    // celebration still happens.
    const audio = new Audio("/audio/tada.mp3");
    audio.volume = 0.8;
    audio.play().catch(() => {
      // autoplay blocked; nothing else to do
    });
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    }
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      // Stop the jingle if the dialog is dismissed early.
      audio.pause();
      audio.currentTime = 0;
    };
  }, [onClose]);

  return (
    <div className={styles.backdrop}>
      <div className={styles.card} role="dialog" aria-label="Puzzle solved">
        <div className={styles.confetti} aria-hidden>
          {CONFETTI.map((g, i) => (
            <span key={i} className={styles.piece} style={{ animationDelay: `${i * 0.12}s` }}>
              {g}
            </span>
          ))}
        </div>
        <h2 className={styles.title}>Congratulations!</h2>
        <p className={styles.body}>You solved the puzzle.</p>
        <div className={styles.actions}>
          <button
            type="button"
            ref={primaryRef}
            className={`${styles.button} ${styles.primary}`}
            onClick={onNewGame}
          >
            Play a new game
          </button>
          <button type="button" className={styles.button} onClick={onClose}>
            Keep looking
          </button>
        </div>
      </div>
    </div>
  );
}
