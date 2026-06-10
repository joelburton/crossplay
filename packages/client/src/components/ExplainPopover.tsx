import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import styles from "./ExplainPopover.module.css";

export type ExplainState =
  | { kind: "loading" }
  | { kind: "ok"; explanation: string; scratchpad: string; note: string }
  | { kind: "error"; message: string };

type Props = {
  /** Element to anchor the popover to (the active-clue strip). */
  anchor: HTMLElement;
  state: ExplainState;
  onClose: () => void;
};

/** Lightweight popover anchored to the active-clue strip. Shows
 *  "Waiting for AI" immediately, swaps to the cleaned explanation on
 *  success, surfaces an error message on failure. The scratchpad is
 *  hidden behind a "Show reasoning" toggle.
 *
 *  Dismiss: outside click, Escape. No focus trap — the popover
 *  doesn't host inputs, just static text and a toggle button.
 */
export function ExplainPopover({ anchor, state, onClose }: Props) {
  const [showScratchpad, setShowScratchpad] = useState(false);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number; width: number }>({
    left: 0,
    top: 0,
    width: 0,
  });

  // Position the popover OVER the anchor (the board), centered
  // horizontally and slightly inset from the top so the user sees
  // the explanation right where they were looking. position:fixed +
  // viewport-relative rect = no scroll math, no positioning-context
  // surprises.
  useEffect(() => {
    const updatePos = () => {
      const rect = anchor.getBoundingClientRect();
      const width = Math.min(rect.width - 16, 520);
      setPos({
        left: rect.left + (rect.width - width) / 2,
        top: rect.top + 24,
        width,
      });
    };
    updatePos();
    window.addEventListener("resize", updatePos);
    window.addEventListener("scroll", updatePos, true);
    return () => {
      window.removeEventListener("resize", updatePos);
      window.removeEventListener("scroll", updatePos, true);
    };
  }, [anchor]);

  // Escape to dismiss. Attached to window so any focused element
  // (board, input, button) lets Escape pass through.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return createPortal(
    <>
      <div className={styles.backdrop} onClick={onClose} />
      <div
        ref={popoverRef}
        className={styles.popover}
        style={{ left: pos.left, top: pos.top, width: pos.width }}
        role="dialog"
        aria-label="Clue explanation"
        onClick={(e) => e.stopPropagation()}
      >
        {state.kind === "loading" && (
          <div className={styles.waiting}>Waiting for AI…</div>
        )}
        {state.kind === "error" && (
          <div className={styles.error}>{state.message}</div>
        )}
        {state.kind === "ok" && (
          <>
            <div className={styles.note}>
              <span className={styles.noteLabel}>Setter's note:</span>
              {state.note.trim().length > 0 ? (
                state.note
              ) : (
                <em>(no per-clue entry)</em>
              )}
            </div>
            <div
              className={styles.body}
              dangerouslySetInnerHTML={{ __html: renderExplanation(state.explanation) }}
            />
            {state.scratchpad && (
              <>
                <button
                  type="button"
                  className={styles.toggle}
                  onClick={() => setShowScratchpad((s) => !s)}
                >
                  {showScratchpad ? "Hide reasoning" : "Show reasoning"}
                </button>
                {showScratchpad && (
                  <div className={styles.scratchpad}>{state.scratchpad}</div>
                )}
              </>
            )}
          </>
        )}
      </div>
    </>,
    document.body,
  );
}

/** The model emits markdown-style `**bold**` for the section labels
 *  (Definition / Wordplay / Indicators). We render those as <strong>
 *  and otherwise escape the text — the explanation is plain prose,
 *  not HTML. Newlines are preserved by `white-space: pre-wrap` on
 *  the container. */
function renderExplanation(text: string): string {
  const escaped = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return escaped.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
}
