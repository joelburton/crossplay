import { useState } from "react";
import { uploadPuzzle } from "../api";
import styles from "./UploadForm.module.css";

type Props = {
  onUploaded: (puzzleId: string) => void;
};

export function UploadForm({ onUploaded }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const { puzzleId } = await uploadPuzzle(file);
      onUploaded(puzzleId);
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
          accept=".puz"
          onChange={onChange}
          disabled={busy}
          className={styles.input}
        />
        <span>{busy ? "Loading..." : "Choose a .puz file"}</span>
      </label>
      {error && <p className={styles.error}>{error}</p>}
    </div>
  );
}
