import { useEffect, useRef, useState } from "react";
import type { ChatIdentity } from "../chatIdentity";
import { NAME_MAX } from "../chatIdentity";
import type { ChatLine } from "../usePuzzleSocket";
import styles from "./ChatPanel.module.css";

type Props = {
  identity: ChatIdentity;
  messages: ChatLine[];
  onSend: (text: string) => void;
  onRename: (newName: string) => void;
  onClose: () => void;
};

export function ChatPanel({ identity, messages, onSend, onRename, onClose }: Props) {
  const [draft, setDraft] = useState("");
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState(identity.name);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const nameInputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!editingName) inputRef.current?.focus();
  }, [editingName]);

  useEffect(() => {
    if (editingName) nameInputRef.current?.focus();
  }, [editingName]);

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

  function startRename() {
    setNameDraft(identity.name);
    setEditingName(true);
  }
  function commitRename() {
    const next = nameDraft.trim();
    if (next.length > 0 && next !== identity.name) onRename(next);
    setEditingName(false);
  }
  function cancelRename() {
    setEditingName(false);
  }
  function onNameKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      e.preventDefault();
      commitRename();
    } else if (e.key === "Escape") {
      e.preventDefault();
      cancelRename();
    }
  }

  return (
    <aside className={styles.panel} aria-label="Chat">
      <header className={styles.header}>
        {editingName ? (
          <input
            ref={nameInputRef}
            className={styles.nameInput}
            value={nameDraft}
            onChange={(e) => setNameDraft(e.target.value)}
            onKeyDown={onNameKey}
            onBlur={commitRename}
            maxLength={NAME_MAX}
            placeholder="New name"
            aria-label="Edit name"
          />
        ) : (
          <span className={styles.title}>
            Chat as{" "}
            <span style={{ color: identity.color, fontWeight: 700 }}>{identity.name}</span>
            <button
              type="button"
              className={styles.editName}
              onClick={startRename}
              aria-label="Edit name"
              title="Edit name"
            >
              <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
                <path
                  d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"
                  fill="currentColor"
                />
              </svg>
            </button>
          </span>
        )}
        <button type="button" className={styles.close} onClick={onClose} aria-label="Close chat">
          ×
        </button>
      </header>
      <div ref={listRef} className={styles.list}>
        {messages.length === 0 ? (
          <div className={styles.empty}>No messages yet.</div>
        ) : (
          messages.map((m, i) => {
            const important = m.text.startsWith("!");
            const body = important ? m.text.slice(1) : m.text;
            return (
              <div key={i} className={styles.line}>
                <span className={styles.name} style={{ color: m.color }}>
                  {m.name}
                </span>
                <span className={`${styles.text} ${important ? styles.important : ""}`}>
                  {body}
                </span>
              </div>
            );
          })
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
