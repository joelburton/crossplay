import { useEffect, useRef } from "react";
import styles from "./NoteDialog.module.css";

type Props = {
  title: string;
  note: string;
  onClose: () => void;
};

export function NoteDialog({ title, note, onClose }: Props) {
  const cardRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  function onBackdropClick(e: React.MouseEvent) {
    if (cardRef.current && !cardRef.current.contains(e.target as Node)) {
      onClose();
    }
  }

  return (
    <div className={styles.backdrop} onClick={onBackdropClick}>
      <div ref={cardRef} className={styles.card} role="dialog" aria-label={`${title} notes`}>
        <header className={styles.header}>
          <h2 className={styles.title}>{title}</h2>
          <button type="button" className={styles.close} onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>
        <div className={styles.body}>{note}</div>
      </div>
    </div>
  );
}
