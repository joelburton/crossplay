import type { ChatLine } from "../usePuzzleSocket";
import styles from "./ChatPreview.module.css";

type Props = {
  line: ChatLine;
};

const MAX_WORDS = 12;

function previewText(text: string): string {
  const stripped = text.startsWith("!") ? text.slice(1) : text;
  const firstLine = stripped.split("\n")[0]!;
  const words = firstLine.trim().split(/\s+/);
  if (words.length <= MAX_WORDS) return firstLine;
  return words.slice(0, MAX_WORDS).join(" ") + "...";
}

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
