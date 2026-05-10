import styles from "./ChatIndicator.module.css";

type Props = {
  unreadCount: number;
  unreadColor: string | null;
  open: boolean;
  onToggle: () => void;
};

const SUBTLE = "#d0d0d0";

/**
 * Floating round button at the top-right that opens/closes the chat
 * panel. When closed and there are unread messages, the button takes on
 * the most-recent sender's color and shows a small unread-count badge;
 * otherwise it stays a subtle gray.
 *
 * Position: `position: fixed` with right edge on `--chat-right`, which
 * PuzzleView keeps in sync with the board's right edge in narrow
 * viewports.
 */
export function ChatIndicator({ unreadCount, unreadColor, open, onToggle }: Props) {
  const showColor = unreadCount > 0 && unreadColor ? unreadColor : SUBTLE;
  const ariaLabel = open
    ? "Close chat"
    : unreadCount > 0
      ? `Open chat (${unreadCount} unread)`
      : "Open chat";
  return (
    <button
      type="button"
      className={`${styles.button} ${open ? styles.open : ""}`}
      style={{ background: showColor }}
      onClick={onToggle}
      aria-label={ariaLabel}
    >
      <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
        <path
          d="M4 4h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-9l-5 4v-4H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z"
          fill="#fff"
        />
      </svg>
      {unreadCount > 0 && (
        <span className={styles.badge}>{unreadCount > 99 ? "99+" : unreadCount}</span>
      )}
    </button>
  );
}
