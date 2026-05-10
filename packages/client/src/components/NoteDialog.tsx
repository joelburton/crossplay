import { useEffect, useState } from "react";
import { Rnd } from "react-rnd";
import styles from "./NoteDialog.module.css";

type Props = {
  title: string;
  note: string;
  onClose: () => void;
};

type Rect = { x: number; y: number; width: number; height: number };

const STORAGE_KEY = "crossplay.notesRect";
const DEFAULT_WIDTH = 600;
const DEFAULT_HEIGHT = 480;
const MIN_WIDTH = 300;
const MIN_HEIGHT = 200;
const VIEWPORT_PAD = 20;

function defaultRect(): Rect {
  const w = Math.min(DEFAULT_WIDTH, window.innerWidth - VIEWPORT_PAD * 2);
  const h = Math.min(DEFAULT_HEIGHT, window.innerHeight - VIEWPORT_PAD * 2);
  return {
    x: Math.max(VIEWPORT_PAD, (window.innerWidth - w) / 2),
    y: Math.max(VIEWPORT_PAD, (window.innerHeight - h) / 3),
    width: w,
    height: h,
  };
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

function clampToViewport(r: Rect): Rect {
  const width = Math.max(MIN_WIDTH, Math.min(r.width, window.innerWidth - VIEWPORT_PAD * 2));
  const height = Math.max(MIN_HEIGHT, Math.min(r.height, window.innerHeight - VIEWPORT_PAD * 2));
  const x = Math.max(VIEWPORT_PAD, Math.min(r.x, window.innerWidth - width - VIEWPORT_PAD));
  const y = Math.max(VIEWPORT_PAD, Math.min(r.y, window.innerHeight - height - VIEWPORT_PAD));
  return { x, y, width, height };
}

export function NoteDialog({ title, note, onClose }: Props) {
  const [rect, setRect] = useState<Rect>(() => loadRect());

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

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
      <div className={styles.card} role="dialog" aria-label={`${title} notes`}>
        <header className={`${styles.header} ${styles.dragHandle}`}>
          <h2 className={styles.title}>{title}</h2>
          <button type="button" className={styles.close} onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>
        <div className={styles.body}>{note}</div>
      </div>
    </Rnd>
  );
}
