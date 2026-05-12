import { useEffect, useRef, useState } from "react";
import styles from "./UserMenu.module.css";

type Props = {
  handle: string;
  onLogout: () => void;
};

/**
 * Top-right user dropdown on the board page. Trigger is the account
 * handle + a ▾ glyph; clicking toggles a small menu with "Log out"
 * (and room for future entries — "Preferences", "Change password",
 * etc.). Outside-click + Escape close it.
 *
 * Deliberately simpler than the title `Menu` component — that one
 * has arrow-key traversal across many entries; here there's almost
 * always just one item, so Enter / Esc / click is enough.
 */
export function UserMenu({ handle, onLogout }: Props) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: PointerEvent) {
      if (!(e.target instanceof Node)) return;
      if (wrapRef.current?.contains(e.target)) return;
      setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={wrapRef} className={styles.wrap}>
      <button
        type="button"
        className={styles.trigger}
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <span className={styles.handle}>{handle}</span>
        <span className={styles.caret} aria-hidden="true">
          ▾
        </span>
      </button>
      {open && (
        <div className={styles.menu} role="menu">
          <button
            type="button"
            className={styles.item}
            onClick={() => {
              setOpen(false);
              onLogout();
            }}
            role="menuitem"
          >
            Log out
          </button>
        </div>
      )}
    </div>
  );
}
