import { useEffect, useRef, useState } from "react";
import type { ChatIdentity } from "../chatIdentity";
import type { ChatLine } from "../usePuzzleSocket";
import styles from "./ChatPanel.module.css";

type Props = {
  identity: ChatIdentity;
  messages: ChatLine[];
  onSend: (text: string) => void;
  onClose: () => void;
};

export function ChatPanel({ identity, messages, onSend, onClose }: Props) {
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length]);

  function submit() {
    const text = draft.trim();
    if (!text) return;
    onSend(text);
    setDraft("");
  }

  function onInputKey(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
      return;
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  }

  return (
    <aside className={styles.panel} aria-label="Chat">
      <header className={styles.header}>
        <span className={styles.title}>
          Chat as <span style={{ color: identity.color, fontWeight: 700 }}>{identity.name}</span>
        </span>
        <button type="button" className={styles.close} onClick={onClose} aria-label="Close chat">
          ×
        </button>
      </header>
      <div ref={listRef} className={styles.list}>
        {messages.length === 0 ? (
          <div className={styles.empty}>No messages yet.</div>
        ) : (
          messages.map((m, i) => (
            <div key={i} className={styles.line}>
              <span className={styles.name} style={{ color: m.color }}>
                {m.name}
              </span>
              <span className={styles.text}>{m.text}</span>
            </div>
          ))
        )}
      </div>
      <textarea
        ref={inputRef}
        className={styles.input}
        rows={2}
        value={draft}
        placeholder="Message (Enter to send, Shift+Enter for newline)"
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={onInputKey}
        maxLength={500}
      />
    </aside>
  );
}
