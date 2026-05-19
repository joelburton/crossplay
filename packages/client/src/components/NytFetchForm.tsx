import { useState } from "react";
import { fetchNytBoard } from "../api";
import styles from "./NytFetchForm.module.css";

type Props = {
  onFetched: (boardId: string) => void;
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
export function NytFetchForm({ onFetched }: Props) {
  const [date, setDate] = useState(todayLocalIso);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
      {error && <p className={styles.error}>{error}</p>}
    </form>
  );
}
