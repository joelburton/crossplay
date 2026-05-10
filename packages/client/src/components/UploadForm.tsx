import { useState } from "react";
import { uploadBoard } from "../api";
import styles from "./UploadForm.module.css";

type Props = {
  onUploaded: (boardId: string) => void;
};

/**
 * Multipart `.puz` / `.ipuz` upload form. Used on the home page and as a
 * fallback under the error state in App. Shows "Loading…" while the
 * upload is in flight, an inline error message on failure, and calls
 * `onUploaded(boardId)` on success — App handles the navigation. The
 * upload creates a board (a one-off playthrough) directly; it does NOT
 * add a puzzle to the curated library.
 */
export function UploadForm({ onUploaded }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const { boardId } = await uploadBoard(file);
      onUploaded(boardId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "upload failed");
      setBusy(false);
    }
  }

  return (
    <div className={styles.wrap}>
      <label className={styles.dropzone}>
        <input
          type="file"
          accept=".puz,.ipuz"
          onChange={onChange}
          disabled={busy}
          className={styles.input}
        />
        <span>{busy ? "Loading..." : "Choose a .puz or .ipuz file"}</span>
      </label>
      {error && <p className={styles.error}>{error}</p>}
    </div>
  );
}
