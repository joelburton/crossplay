import type { ChatLine } from "../useBoardSocket";
import { previewText } from "../previewText";
import styles from "./ChatPreview.module.css";

type Props = {
  line: ChatLine;
};

/**
 * Small "toast" pill that briefly shows a new chat message above the
 * board when the chat panel is closed. PuzzleView sets a 3-second
 * timer on each new message; this component renders during that
 * window. Purely visual: shows a truncated preview, never marks
 * messages as read, and is `aria-hidden` (the full chat panel is the
 * canonical surface).
 */
export function ChatPreview({ line }: Props) {
  return (
    <div className={styles.preview} aria-hidden="true">
      <span className={styles.name} style={{ color: line.color }}>
        {line.name}
      </span>
      <span className={styles.colon}>:</span>
      <span className={styles.body}>{previewText(line.text)}</span>
    </div>
  );
}
