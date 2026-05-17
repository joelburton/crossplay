import { useEffect, useRef, useState } from "react";
import { Rnd } from "react-rnd";
import { SCRATCHPAD_MAX_LEN } from "@crossplay/shared";
import type { ChatIdentity } from "../chatIdentity";
import { useDraggablePanel, type Rect } from "../draggablePanel";
import styles from "./ScratchpadPanel.module.css";

export type ScratchpadLock = { name: string; color: string };

type Props = {
  identity: ChatIdentity;
  text: string;
  lockedBy: ScratchpadLock | null;
  onEdit: (text: string) => void;
  onTakeover: () => void;
  onClose: () => void;
};

const PANEL_OPTS = {
  storageKey: "crossplay.scratchpadRect",
  minWidth: 240,
  minHeight: 180,
  viewportPad: 8,
  defaultRect(): Rect {
    const w = Math.min(360, window.innerWidth - 16);
    const h = Math.min(280, window.innerHeight - 60);
    // Default position: bottom-right corner, but stacked a bit lower
    // than chat (which defaults top-right) so the two don't perfectly
    // overlap on first open. Users drag from there.
    return {
      x: Math.max(8, window.innerWidth - w - 8),
      y: Math.max(44, window.innerHeight - h - 24),
      width: w,
      height: h,
    };
  },
};

/** How long to wait between the user's last keystroke and the
 *  outbound `scratchpadEdit`. Long enough to coalesce a typing flurry
 *  into a single broadcast; short enough that a peer's view doesn't
 *  feel stale. Pairs with the server's 1s takeover grace window
 *  (SCRATCHPAD_TAKEOVER_GRACE_MS): each persisted keystroke extends
 *  the grace, so an active typist stays comfortably locked. */
const EDIT_DEBOUNCE_MS = 200;

/**
 * Draggable / resizable shared notes scratchpad.
 *
 * One writer at a time, enforced server-side by a per-board in-memory
 * lock. The UI is symmetric across players:
 *  - if you hold the lock, the textarea is editable and a "Release"-
 *    free affordance reads "You're editing" (only takeovers can
 *    transfer the lock — there's no explicit give-up gesture);
 *  - if someone else holds it, the textarea is read-only and a
 *    "Take over" button steals the lock (subject to the server's
 *    active-typing grace);
 *  - if nobody holds it, "Edit" claims it without contesting.
 *
 * Local typing renders immediately (optimistic) and the outbound
 * `scratchpadEdit` is debounced. When the lock transfers away, the
 * effect that watches isHolder re-syncs the local draft to whatever
 * the server has — so a stolen lock can't leave stale text behind on
 * the former editor's screen.
 *
 * Open/close state is per-client and intentionally NOT synced —
 * someone else opening the scratchpad doesn't summon yours.
 */
export function ScratchpadPanel({
  identity,
  text,
  lockedBy,
  onEdit,
  onTakeover,
  onClose,
}: Props) {
  const { rect, onDragStop, onResizeStop } = useDraggablePanel(PANEL_OPTS);
  const [draft, setDraft] = useState(text);
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  // Identity-based "do I hold the lock" check. Server tracks the lock
  // by socket reference (so it auto-releases on disconnect); the
  // wire only carries name+color, so the client matches on that.
  // Two players who share both name AND color would both think they
  // hold simultaneously — the server still rejects edits from the
  // wrong socket, so the worst-case is brief UI confusion, not data
  // corruption. Same trade-off chat makes.
  const isHolder =
    lockedBy != null &&
    lockedBy.name === identity.name &&
    lockedBy.color === identity.color;

  // When we don't hold the lock, the server is the source of truth:
  // adopt incoming text into the local draft so the textarea shows
  // what peers are typing. When we DO hold it, we ignore incoming
  // text (we're the only writer; server echoes match what we sent).
  // This same effect handles the steal-from-us case: as soon as the
  // lock transfers away, isHolder flips false and our (possibly
  // ahead-of-server) draft snaps back to canonical.
  useEffect(() => {
    if (!isHolder) setDraft(text);
  }, [text, isHolder]);

  // Flush pending debounce on unmount so a closing user doesn't lose
  // their last burst of typing.
  useEffect(() => {
    return () => {
      if (debounceTimer.current) clearTimeout(debounceTimer.current);
    };
  }, []);

  function onTextareaChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    if (!isHolder) return; // textarea is disabled in this state, defensive
    const next = e.target.value.slice(0, SCRATCHPAD_MAX_LEN);
    setDraft(next);
    if (debounceTimer.current) clearTimeout(debounceTimer.current);
    debounceTimer.current = setTimeout(() => {
      debounceTimer.current = null;
      onEdit(next);
    }, EDIT_DEBOUNCE_MS);
  }

  function onTextareaKey(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  }

  function handleTakeover() {
    onTakeover();
    // Focus the textarea so the user can start typing the moment the
    // server confirms the lock transfer. If the takeover is rejected
    // (within grace), focus is harmless — the textarea stays disabled.
    queueMicrotask(() => textareaRef.current?.focus());
  }

  // Lock-status copy + button, rendered inline in the title bar. The
  // three states correspond directly to the server's lock state:
  // holder=you, holder=someone, no holder.
  let lockStatus: React.ReactNode;
  let lockButton: React.ReactNode = null;
  if (isHolder) {
    lockStatus = (
      <>
        <span style={{ color: identity.color }}>●</span> You&apos;re editing
      </>
    );
  } else if (lockedBy) {
    lockStatus = (
      <>
        <span style={{ color: lockedBy.color }}>●</span>{" "}
        <span className={styles.lockHolder}>{lockedBy.name}</span> is editing
      </>
    );
    lockButton = (
      <button type="button" className={styles.lockButton} onClick={handleTakeover}>
        Take over
      </button>
    );
  } else {
    lockStatus = <>No one is editing</>;
    lockButton = (
      <button type="button" className={styles.lockButton} onClick={handleTakeover}>
        Edit
      </button>
    );
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
      <aside className={styles.panel} aria-label="Scratchpad">
        <header className={`${styles.header} ${styles.dragHandle}`}>
          <span className={styles.title}>Scratchpad</span>
          <span className={styles.lockText}>{lockStatus}</span>
          {lockButton}
          <button
            type="button"
            className={styles.close}
            onClick={onClose}
            aria-label="Close scratchpad"
          >
            ×
          </button>
        </header>
        <textarea
          ref={textareaRef}
          className={styles.textarea}
          value={draft}
          disabled={!isHolder}
          onChange={onTextareaChange}
          onKeyDown={onTextareaKey}
          maxLength={SCRATCHPAD_MAX_LEN}
          spellCheck={false}
          placeholder={
            isHolder
              ? "Anagram fodder, working notes, etc."
              : lockedBy
                ? `Read-only — ${lockedBy.name} is editing`
                : "Click Edit to start"
          }
        />
      </aside>
    </Rnd>
  );
}
