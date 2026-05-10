import { useEffect, useRef, useState } from "react";
import type { MutableRefObject } from "react";
import { Rnd } from "react-rnd";
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
  inputRef?: MutableRefObject<HTMLTextAreaElement | null>;
};

type Rect = { x: number; y: number; width: number; height: number };

const STORAGE_KEY = "crossplay.chatRect";
const DEFAULT_WIDTH = 340;
const DEFAULT_HEIGHT = 460;
const MIN_WIDTH = 240;
const MIN_HEIGHT = 200;
const VIEWPORT_PAD = 8;

const URL_RE = /https?:\/\/\S+/g;
const TRAIL_RE = /[.,!?;:)\]}>]+$/;

function linkify(text: string): React.ReactNode {
  const parts: React.ReactNode[] = [];
  let last = 0;
  let key = 0;
  for (const m of text.matchAll(URL_RE)) {
    const start = m.index!;
    if (start > last) parts.push(text.slice(last, start));
    let url = m[0];
    let trail = "";
    const tm = url.match(TRAIL_RE);
    if (tm) {
      trail = tm[0];
      url = url.slice(0, -trail.length);
    }
    parts.push(
      <a key={key++} href={url} target="_blank" rel="noopener noreferrer">
        {url}
      </a>,
    );
    if (trail) parts.push(trail);
    last = start + m[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts.length === 0 ? text : parts;
}

function defaultRect(): Rect {
  const w = Math.min(DEFAULT_WIDTH, window.innerWidth - VIEWPORT_PAD * 2);
  const h = Math.min(DEFAULT_HEIGHT, window.innerHeight - 60);
  return {
    x: Math.max(VIEWPORT_PAD, window.innerWidth - w - VIEWPORT_PAD),
    y: 44,
    width: w,
    height: h,
  };
}

function clampToViewport(r: Rect): Rect {
  const width = Math.max(MIN_WIDTH, Math.min(r.width, window.innerWidth - VIEWPORT_PAD * 2));
  const height = Math.max(MIN_HEIGHT, Math.min(r.height, window.innerHeight - VIEWPORT_PAD * 2));
  const x = Math.max(VIEWPORT_PAD, Math.min(r.x, window.innerWidth - width - VIEWPORT_PAD));
  const y = Math.max(VIEWPORT_PAD, Math.min(r.y, window.innerHeight - height - VIEWPORT_PAD));
  return { x, y, width, height };
}

function loadRect(): Rect {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultRect();
    const r = JSON.parse(raw) as Partial<Rect>;
    if (
      typeof r.x === "number" &&
      typeof r.y === "number" &&
      typeof r.width === "number" &&
      typeof r.height === "number"
    ) {
      return clampToViewport(r as Rect);
    }
  } catch {
    // fall through
  }
  return defaultRect();
}

function saveRect(r: Rect): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(r));
  } catch {
    // ignore
  }
}

export function ChatPanel({ identity, messages, onSend, onRename, onClose, inputRef }: Props) {
  const [draft, setDraft] = useState("");
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState(identity.name);
  const [rect, setRect] = useState<Rect>(() => loadRect());
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

  useEffect(() => {
    function onResize() {
      setRect((cur) => {
        const next = clampToViewport(cur);
        if (
          next.x === cur.x &&
          next.y === cur.y &&
          next.width === cur.width &&
          next.height === cur.height
        ) return cur;
        saveRect(next);
        return next;
      });
    }
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

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
      minWidth={MIN_WIDTH}
      minHeight={MIN_HEIGHT}
      bounds="window"
      dragHandleClassName={styles.dragHandle}
      onDragStop={(_e, d) => {
        const next = { ...rect, x: d.x, y: d.y };
        setRect(next);
        saveRect(next);
      }}
      onResizeStop={(_e, _dir, refEl, _delta, position) => {
        const next = {
          x: position.x,
          y: position.y,
          width: refEl.offsetWidth,
          height: refEl.offsetHeight,
        };
        setRect(next);
        saveRect(next);
      }}
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
