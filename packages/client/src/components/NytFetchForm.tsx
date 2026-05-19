import { useState } from "react";
import { fetchNytBoard } from "../api";
import { SettingsDialog } from "./SettingsDialog";
import styles from "./NytFetchForm.module.css";

type Props = {
  onFetched: (boardId: string) => void;
  /** Whether the user currently has a stored cookie — forwarded to
   *  SettingsDialog when we offer it as a one-click "fix this" path
   *  after a fetch failure. */
  hasNytCookie: boolean;
  /** Bubbled up to App so it can patch its in-memory user shape when
   *  the user re-pastes (or clears) the cookie from the inline
   *  Settings affordance below. */
  onNytCookieChanged: (hasNytCookie: boolean) => void;
};

/** Today as `yyyy-mm-dd` in the *user's* local time. The NYT publishes
 *  the next day's puzzle around 10pm Eastern, but we leave that nuance
 *  to the user — they can type whatever date they want. */
function todayLocalIso(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * Date input + "Get from NYT" button. Lives below `UploadForm` in the
 * third home-page column, and is only rendered when the user has a
 * stored cookie jar (`hasNytCookie`). The server holds the cookie;
 * this form just sends a date and gets back a board id.
 */
export function NytFetchForm({ onFetched, hasNytCookie, onNytCookieChanged }: Props) {
  const [date, setDate] = useState(todayLocalIso);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!date || busy) return;
    setBusy(true);
    setError(null);
    try {
      const { boardId } = await fetchNytBoard(date);
      onFetched(boardId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "fetch failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className={styles.wrap} onSubmit={onSubmit}>
      <label className={styles.label}>
        Date
        <input
          type="date"
          className={styles.date}
          value={date}
          onChange={(e) => setDate(e.target.value)}
          disabled={busy}
          required
        />
      </label>
      <button type="submit" className={styles.button} disabled={busy || !date}>
        {busy ? "Fetching…" : "Get from NYT"}
      </button>
      {error && (
        <>
          <p className={styles.error}>{error}</p>
          {/* The realistic failure mode here is "cookie expired" —
              every other error path (network, NYT outage) is rare and
              transient. Make the fix one click instead of "now find
              the user menu". */}
          <button
            type="button"
            className={styles.linkButton}
            onClick={() => setSettingsOpen(true)}
          >
            Update NYT cookie…
          </button>
        </>
      )}
      {settingsOpen && (
        <SettingsDialog
          hasNytCookie={hasNytCookie}
          onSaved={onNytCookieChanged}
          onClose={() => setSettingsOpen(false)}
        />
      )}
    </form>
  );
}
