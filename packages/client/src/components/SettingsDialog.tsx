import { useEffect, useRef, useState } from "react";
import { type NytCookieJar, fetchNytCookie, saveNytCookie } from "../api";
import styles from "./SettingsDialog.module.css";

type Props = {
  /** Current `hasNytCookie` state at open. Drives the initial fetch
   *  decision (skip the GET when there's nothing stored). */
  hasNytCookie: boolean;
  /** Called whenever the cookie state flips (save or clear). Carries
   *  the new boolean so the parent can patch its in-memory user
   *  shape and toggle the NYT-fetch form on the home page. */
  onSaved: (hasNytCookie: boolean) => void;
  onClose: () => void;
};

type LoadState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "loaded"; cookie: NytCookieJar | null; warning?: string }
  | { kind: "error"; message: string };

/**
 * Minimal settings dialog. Today its only job is the NYT cookie blob:
 *   - shows the currently-stored jar (decoded) so the user can see
 *     what we have on file
 *   - accepts a fresh base64 paste from the dump-nyt-cookies binary
 *   - "Clear" wipes the column
 *
 * Validation happens server-side; the route surfaces a precise
 * message ("decoded value isn't JSON", "object is empty", etc.)
 * which we display inline.
 *
 * Modeled on `HelpDialog`: backdrop + card, Esc / outside-click close.
 */
export function SettingsDialog({ hasNytCookie, onSaved, onClose }: Props) {
  const cardRef = useRef<HTMLDivElement | null>(null);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  // Tracks the live "what's currently stored" state, kept in sync
  // with the server: fetched on mount when hasNytCookie was true,
  // updated optimistically after a successful save/clear. Starts as
  // `{ cookie: null }` (loaded, nothing) when hasNytCookie was false
  // so we skip a needless GET.
  const [load, setLoad] = useState<LoadState>(() =>
    hasNytCookie ? { kind: "loading" } : { kind: "loaded", cookie: null },
  );

  useEffect(() => {
    if (load.kind !== "loading") return;
    let cancelled = false;
    fetchNytCookie()
      .then((res) => {
        if (cancelled) return;
        setLoad({ kind: "loaded", cookie: res.cookie, warning: res.error });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setLoad({
          kind: "error",
          message: err instanceof Error ? err.message : "couldn't load cookie",
        });
      });
    return () => {
      cancelled = true;
    };
  }, [load.kind]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      // Don't swallow Esc when focus is in the textarea — accidental
      // Esc presses during a paste shouldn't nuke the dialog. Esc on
      // the backdrop / a button still closes.
      if (e.key !== "Escape") return;
      const t = e.target;
      if (t instanceof HTMLTextAreaElement) return;
      e.stopPropagation();
      onClose();
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  function onBackdropClick(e: React.MouseEvent) {
    if (cardRef.current && !cardRef.current.contains(e.target as Node)) {
      onClose();
    }
  }

  async function onSave() {
    const trimmed = value.trim();
    if (!trimmed) {
      setError("Paste the output of dump-nyt-cookies first.");
      return;
    }
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      const { hasNytCookie: now, cookie } = await saveNytCookie(trimmed);
      onSaved(now);
      setLoad({ kind: "loaded", cookie });
      setValue("");
      setStatus(`Saved. ${cookie ? Object.keys(cookie).length : 0} cookies stored.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "save failed");
    } finally {
      setBusy(false);
    }
  }

  async function onClear() {
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      const { hasNytCookie: now } = await saveNytCookie(null);
      onSaved(now);
      setLoad({ kind: "loaded", cookie: null });
      setStatus("Cleared.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "clear failed");
    } finally {
      setBusy(false);
    }
  }

  // Derived "current jar" view. `loaded.cookie === null` means nothing
  // is stored; non-null means we have a parsed object to render.
  const stored =
    load.kind === "loaded" ? load.cookie : null;
  const hasStored = stored !== null;

  return (
    <div className={styles.backdrop} onMouseDown={onBackdropClick}>
      <div
        className={styles.card}
        ref={cardRef}
        role="dialog"
        aria-label="Settings"
      >
        <header className={styles.header}>
          <h2 className={styles.title}>Settings</h2>
          <button
            type="button"
            className={styles.close}
            onClick={onClose}
            aria-label="Close"
          >
            ×
          </button>
        </header>
        <div className={styles.body}>
          <section>
            <h3>NYT cookie</h3>
            <p className={styles.status}>
              {hasStored ? (
                <>
                  <strong>Saved.</strong> Paste a new value below to replace
                  it, or click <em>Clear</em> to remove it.
                </>
              ) : (
                <>
                  <strong>Not set.</strong> Once saved, you can fetch puzzles
                  directly from your NYT account on the home page.
                </>
              )}
            </p>

            {load.kind === "loading" && (
              <p className={styles.muted}>Loading current cookie…</p>
            )}
            {load.kind === "error" && (
              <p className={styles.error}>Couldn't load: {load.message}</p>
            )}
            {load.kind === "loaded" && load.warning && (
              <p className={styles.error}>
                Stored value couldn't be parsed: {load.warning}. Paste a fresh
                one below.
              </p>
            )}
            {load.kind === "loaded" && stored && (
              <>
                <p className={styles.help}>Currently stored cookies:</p>
                <pre className={styles.json}>
                  {JSON.stringify(stored, null, 2)}
                </pre>
              </>
            )}

            <p className={styles.help}>
              Run <code>dump-nyt-cookies</code> on the machine where you're
              logged into nytimes.com, then paste the single line it prints
              below.
            </p>
            <textarea
              className={styles.textarea}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder="Paste the base64 line from dump-nyt-cookies here…"
              spellCheck={false}
              autoCorrect="off"
              autoCapitalize="off"
              disabled={busy}
              rows={6}
            />
            {error && <p className={styles.error}>{error}</p>}
            {status && <p className={styles.statusOk}>{status}</p>}
            <div className={styles.buttons}>
              <button
                type="button"
                className={styles.primary}
                onClick={() => void onSave()}
                disabled={busy || !value.trim()}
              >
                {busy ? "Saving…" : "Save"}
              </button>
              {hasStored && (
                <button
                  type="button"
                  className={styles.secondary}
                  onClick={() => void onClear()}
                  disabled={busy}
                >
                  Clear
                </button>
              )}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
