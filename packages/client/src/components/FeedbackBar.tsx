import type { Feedback } from "../feedback";
import styles from "./FeedbackBar.module.css";

type Props = {
  feedback: Feedback;
  onDismiss: () => void;
};

/**
 * Pill-shaped feedback bar that occupies the header slot when active.
 *
 * Triggers (today): the welcome message on puzzle load, server-emitted
 * "X joined" and "Check skips pencil cells" notices, and the
 * client-emitted "No notes for this puzzle" notice. The visual level
 * (info / warning / celebration) maps to a CSS class in the same module.
 *
 * Click anywhere on the bar — or hit the × — to dismiss; App also
 * dismisses on the next puzzle activity (cursor move, type, click).
 */
export function FeedbackBar({ feedback, onDismiss }: Props) {
  return (
    <div
      className={`${styles.bar} ${styles[feedback.level]}`}
      onClick={onDismiss}
      role="status"
      aria-live="polite"
    >
      <span className={styles.text}>{feedback.text}</span>
      <button
        type="button"
        className={styles.close}
        onClick={(e) => {
          e.stopPropagation();
          onDismiss();
        }}
        aria-label="Dismiss"
      >
        ×
      </button>
    </div>
  );
}
