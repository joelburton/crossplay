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

  // Publish the tab's actual width as a CSS variable so the chat
  // indicator + preview can hug its left edge tightly (instead of
  // reserving a worst-case fixed gap). Set on documentElement so any
  // fixed-position sibling — including elements outside the React
  // tree under .app — can read it. Cleaned up on unmount (anon route
  // resets to 0px).
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const root = document.documentElement;
    const update = () => {
      const w = el.getBoundingClientRect().width;
      // +4px of breathing room between the chat bubble and the tab.
      root.style.setProperty("--user-menu-offset", `${w + 4}px`);
    };
    update();
    // JSDOM (used by client tests) doesn't ship ResizeObserver — fall
    // back to a one-shot measurement on mount. The handle shouldn't
    // change size after that anyway unless the account is renamed
    // (no UI for that today).
    if (typeof ResizeObserver === "undefined") {
      return () => {
        root.style.removeProperty("--user-menu-offset");
      };
    }
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => {
      ro.disconnect();
      root.style.removeProperty("--user-menu-offset");
    };
  }, []);

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
