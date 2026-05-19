import { useEffect, useRef, useState } from "react";
import {
  type NytCookieJar,
  type Prefs,
  fetchNytCookie,
  saveNytCookie,
  savePrefs,
} from "../api";
import { CHAT_PALETTE } from "../chatIdentity";
import styles from "./SettingsDialog.module.css";

type Props = {
  /** Current `hasNytCookie` state at open. Drives the initial fetch
   *  decision (skip the GET when there's nothing stored). */
  hasNytCookie: boolean;
  /** Called whenever the cookie state flips (save or clear). Carries
   *  the new boolean so the parent can patch its in-memory user
   *  shape and toggle the NYT-fetch form on the home page. */
  onSaved: (hasNytCookie: boolean) => void;
  /** Current preferences. Used to pre-select the color swatch. */
  prefs: Prefs;
  /** Bubbled up after a successful prefs save. Carries the post-merge
   *  Prefs so App can patch its in-memory user shape. */
  onPrefsChanged: (prefs: Prefs) => void;
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
export function SettingsDialog({
  hasNytCookie,
  onSaved,
  prefs,
  onPrefsChanged,
  onClose,
}: Props) {
  const cardRef = useRef<HTMLDivElement | null>(null);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  // Currently-selected color (controlled by the swatch grid). Pending
  // until the user clicks OK — closing via Cancel/Esc/× discards it
  // and the stored pref is unchanged. `null` means "use the
  // deterministic name-hash default."
  const [color, setColor] = useState<string | null>(prefs.color ?? null);
  const initialColor = prefs.color ?? null;
  const colorDirty = color !== initialColor;
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
    if (!trimmed && !colorDirty) {
      // Nothing to do; OK shouldn't have been enabled. Defensive
      // no-op so a force-click can't error.
      onClose();
      return;
    }
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      // Cookie first so a real-world auth error (expired cookie,
      // malformed paste) surfaces before we touch prefs — if the
      // cookie save fails, we leave the color pref alone too so the
      // user can fix the cookie input and resubmit both.
      if (trimmed) {
        const { hasNytCookie: now } = await saveNytCookie(trimmed);
        onSaved(now);
        // Clear the buffer so a retry after a *later* failure (e.g.
        // color save) doesn't re-POST the cookie a second time. The
        // server would tolerate it, but the user-visible flow is
        // cleaner if each successful piece doesn't re-fire.
        setValue("");
      }
      if (colorDirty) {
        const { prefs: merged } = await savePrefs({ color });
        onPrefsChanged(merged);
      }
      onClose();
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
            <h3>Color</h3>
            <p className={styles.help}>
              Your color in chat, cursor presence, and the brief flash when
              other players see your letters land. Pick one or use the
              default (chosen from your handle).
            </p>
            <div
              className={styles.swatches}
              role="radiogroup"
              aria-label="Player color"
            >
              {CHAT_PALETTE.map((c) => {
                const selected = color === c;
                return (
                  <button
                    key={c}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    aria-label={`Color ${c}`}
                    className={
                      selected ? `${styles.swatch} ${styles.swatchOn}` : styles.swatch
                    }
                    style={{ background: c }}
                    onClick={() => setColor(c)}
                    disabled={busy}
                  />
                );
              })}
              <button
                type="button"
                role="radio"
                aria-checked={color === null}
                className={
                  color === null
                    ? `${styles.swatchDefault} ${styles.swatchOn}`
                    : styles.swatchDefault
                }
                onClick={() => setColor(null)}
                disabled={busy}
              >
                Default
              </button>
            </div>
          </section>

          <section className={styles.section}>
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
              {/* Destructive action lives on the left, separated by an
                  auto-margin from the Cancel / OK pair so a stray click
                  isn't right next to OK. Only rendered when there's
                  something to clear. */}
              {hasStored && (
                <button
                  type="button"
                  className={styles.destructive}
                  onClick={() => void onClear()}
                  disabled={busy}
                >
                  Clear NYT cookie
                </button>
              )}
              <button
                type="button"
                className={styles.secondary}
                onClick={onClose}
                disabled={busy}
              >
                Cancel
              </button>
              <button
                type="button"
                className={styles.primary}
                onClick={() => void onSave()}
                disabled={busy || (!value.trim() && !colorDirty)}
              >
                {busy ? "Saving…" : "OK"}
              </button>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
