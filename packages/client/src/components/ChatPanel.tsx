import { useEffect, useRef, useState } from "react";
import type { MutableRefObject } from "react";
import { Rnd } from "react-rnd";
import type { ChatIdentity } from "../chatIdentity";
import { NAME_MAX } from "../chatIdentity";
import type { ChatLine } from "../useBoardSocket";
import { linkify } from "../linkify";
import { useDraggablePanel, type Rect } from "../draggablePanel";
import styles from "./ChatPanel.module.css";

type Props = {
  identity: ChatIdentity;
  messages: ChatLine[];
  onSend: (text: string) => void;
  onRename: (newName: string) => void;
  onClose: () => void;
  inputRef?: MutableRefObject<HTMLTextAreaElement | null>;
};

const PANEL_OPTS = {
  storageKey: "crossplay.chatRect",
  minWidth: 240,
  minHeight: 200,
  viewportPad: 8,
  defaultRect(): Rect {
    const w = Math.min(340, window.innerWidth - 16);
    const h = Math.min(460, window.innerHeight - 60);
    return {
      x: Math.max(8, window.innerWidth - w - 8),
      y: 44,
      width: w,
      height: h,
    };
  },
};

/**
 * Draggable / resizable chat panel.
 *
 * Position and size persist in localStorage (`crossplay.chatRect`); on
 * mount we clamp the saved rect against the current viewport. On
 * window resize we re-clamp so the panel can't end up off-screen. The
 * rect/persist/clamp logic is shared with NoteDialog via
 * `useDraggablePanel`.
 *
 * Identity (name + color) is owned upstream in PuzzleView; this
 * component only exposes a rename input that calls `onRename` with the
 * new name. URLs in messages are auto-linkified (see `linkify`), and
 * messages whose first character is `!` render bold + force-open the
 * panel on the recipient side (logic for the latter lives in
 * PuzzleView).
 */
export function ChatPanel({ identity, messages, onSend, onRename, onClose, inputRef }: Props) {
  const [draft, setDraft] = useState("");
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState(identity.name);
  const { rect, onDragStop, onResizeStop } = useDraggablePanel(PANEL_OPTS);
  const localInputRef = useRef<HTMLTextAreaElement | null>(null);
  const tref = inputRef ?? localInputRef;
  const nameInputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!editingName) tref.current?.focus();
  }, [editingName, tref]);

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
    <Rnd
      className={styles.rnd}
      size={{ width: rect.width, height: rect.height }}
      position={{ x: rect.x, y: rect.y }}
      minWidth={PANEL_OPTS.minWidth}
      minHeight={PANEL_OPTS.minHeight}
      bounds="window"
      dragHandleClassName={styles.dragHandle}
      onDragStop={(_e, d) => onDragStop(d.x, d.y)}
      onResizeStop={(_e, _dir, refEl, _delta, position) =>
        onResizeStop(position.x, position.y, refEl.offsetWidth, refEl.offsetHeight)
      }
    >
      <aside className={styles.panel} aria-label="Chat">
        <header className={`${styles.header} ${styles.dragHandle}`}>
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
                    {linkify(body)}
                  </span>
                </div>
              );
            })
          )}
        </div>
        <textarea
          ref={tref}
          className={styles.input}
          rows={2}
          value={draft}
          placeholder="Message (Enter to send, Shift+Enter for newline)"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onInputKey}
          maxLength={500}
        />
      </aside>
    </Rnd>
  );
}
