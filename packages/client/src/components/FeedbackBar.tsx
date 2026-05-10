import type { Feedback } from "../feedback";
import styles from "./FeedbackBar.module.css";

type Props = {
  feedback: Feedback;
  onDismiss: () => void;
};

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
