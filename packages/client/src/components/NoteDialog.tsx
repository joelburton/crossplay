import { useEffect } from "react";
import { Rnd } from "react-rnd";
import { useDraggablePanel, type Rect } from "../draggablePanel";
import styles from "./NoteDialog.module.css";

type Props = {
  title: string;
  note: string;
  onClose: () => void;
};

const PANEL_OPTS = {
  storageKey: "crossplay.notesRect",
  minWidth: 300,
  minHeight: 200,
  viewportPad: 20,
  defaultRect(): Rect {
    const w = Math.min(600, window.innerWidth - 40);
    const h = Math.min(480, window.innerHeight - 40);
    return {
      x: Math.max(20, (window.innerWidth - w) / 2),
      y: Math.max(20, (window.innerHeight - h) / 3),
      width: w,
      height: h,
    };
  },
};

/**
 * Draggable / resizable dialog showing a puzzle's free-form note text.
 *
 * Synchronization model: when any player clicks "Show notes" the server
 * broadcasts `notesShown` to the room and every client opens this
 * dialog. *Closing* is local — each player dismisses their own copy on
 * their own time (Esc or clicking ×).
 *
 * Position and size persist in localStorage (`crossplay.notesRect`),
 * clamped on mount and on window resize. Rect logic is shared with
 * `ChatPanel` via `useDraggablePanel`.
 */
export function NoteDialog({ title, note, onClose }: Props) {
  const { rect, onDragStop, onResizeStop } = useDraggablePanel(PANEL_OPTS);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

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
