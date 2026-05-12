import { useEffect, useRef, useState } from "react";
import { HttpError, shareBoard } from "../api";
import styles from "./ShareDialog.module.css";

type Props = {
  boardId: string;
  onClose: () => void;
};

/**
 * Modal for adding a co-player to the current board. Type a handle,
 * Enter or click Share. On success the dialog stays open so multiple
 * shares per session are quick — the input clears and refocuses, and
 * a running list of "Shared with …" lines accumulates beneath the
 * field. Esc / click-outside dismiss.
 *
 * Server resolves the handle case-insensitively and returns the
 * display-cased form, so a "moth" input comes back as "Moth" in the
 * confirmation line. `alreadyMember:true` (re-share or share-with-
 * self) is treated as a soft success — the message swaps wording but
 * the operation still counts as completed.
 */
export function ShareDialog({ boardId, onClose }: Props) {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  // Each completed share appends a line here; oldest first. Cleared
  // when the dialog re-mounts. We use this rather than a single
  // "last shared" state so the user can confirm they didn't lose
  // a previous share when they queue up several in a row.
  const [shared, setShared] = useState<Array<{ handle: string; already: boolean }>>([]);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const cardRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  async function submit() {
    const handle = value.trim();
    if (!handle || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await shareBoard(boardId, handle);
      setShared((cur) => [...cur, { handle: res.handle, already: res.alreadyMember }]);
      setValue("");
      inputRef.current?.focus();
    } catch (err) {
      // The server includes a user-facing error string for 400/404 —
      // surface it verbatim. Anything else (network, 500) falls back
      // to a generic copy.
      if (err instanceof HttpError) {
        setError(err.message);
      } else {
        setError("Couldn't share — check your connection and try again.");
      }
    } finally {
      setBusy(false);
    }
  }

  function onKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      e.preventDefault();
      void submit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    }
  }

  function onBackdropMouseDown(e: React.MouseEvent) {
    if (cardRef.current && !cardRef.current.contains(e.target as Node)) {
      onClose();
    }
  }

  return (
    <div className={styles.backdrop} onMouseDown={onBackdropMouseDown}>
      <div className={styles.card} ref={cardRef} role="dialog" aria-label="Share board">
        <div className={styles.body}>
          <div className={styles.label}>Share this board with another player</div>
          <div className={styles.row}>
            <input
              ref={inputRef}
              className={styles.input}
              type="text"
              value={value}
              onChange={(e) => {
                setValue(e.target.value);
                if (error) setError(null);
              }}
              onKeyDown={onKey}
              placeholder="handle"
              aria-label="Handle"
              aria-invalid={error !== null || undefined}
              disabled={busy}
            />
            <button
              type="button"
              className={styles.submit}
              onClick={() => void submit()}
              disabled={busy || value.trim().length === 0}
            >
              Share
            </button>
          </div>
          <div className={`${styles.message} ${error ? styles.error : styles.success}`} aria-live="polite">
            {error ?? ""}
          </div>
          {shared.length > 0 && (
            <div className={styles.members}>
              <span className={styles.membersLabel}>Shared with:</span>
              {shared
                .map((s) => (s.already ? `${s.handle} (already a member)` : s.handle))
                .join(", ")}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
