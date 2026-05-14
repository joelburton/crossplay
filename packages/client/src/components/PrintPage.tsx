/**
 * Print view of a board. Lives at `/b/:id/print`, opened in a new tab
 * by the menu's "Print / Save as PDF" item.
 *
 * Fetches the board, then shows a "Generate PDF" button. Clicking it
 * lazy-loads the jsPDF-based print module, builds a Blob, and opens
 * the resulting PDF in a new tab — the user's browser handles the
 * preview / save / print from there. See docs/print-pdf-plan.md.
 */

import { useEffect, useState } from "react";
import type { PuzzleState } from "@crossplay/shared";
import { fetchBoard, HttpError } from "../api";
import styles from "./PrintPage.module.css";

type LoadState =
  | { kind: "loading" }
  | { kind: "loaded"; puzzle: PuzzleState }
  | { kind: "error"; message: string };

export function PrintPage({ boardId }: { boardId: string }) {
  const [load, setLoad] = useState<LoadState>({ kind: "loading" });
  const [busy, setBusy] = useState(false);
  const [genError, setGenError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchBoard(boardId)
      .then((p) => {
        if (!cancelled) setLoad({ kind: "loaded", puzzle: p });
      })
      .catch((err) => {
        if (cancelled) return;
        const message =
          err instanceof HttpError && err.status === 404
            ? "Board not found."
            : err instanceof Error
              ? err.message
              : "failed to load";
        setLoad({ kind: "error", message });
      });
    return () => {
      cancelled = true;
    };
  }, [boardId]);

  const title = load.kind === "loaded" ? load.puzzle.meta.title : "";
  useEffect(() => {
    if (!title) return;
    const prev = document.title;
    document.title = `${title} — Crossplay`;
    return () => {
      document.title = prev;
    };
  }, [title]);

  async function handleGenerate(puzzle: PuzzleState) {
    setBusy(true);
    setGenError(null);
    try {
      const { generateCrosswordPdf } = await import("../print");
      const blob = await generateCrosswordPdf(puzzle);
      const url = URL.createObjectURL(blob);
      window.open(url, "_blank", "noopener");
    } catch (err) {
      setGenError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  if (load.kind === "loading") return <p className={styles.status}>Loading…</p>;
  if (load.kind === "error") return <p className={styles.status}>{load.message}</p>;

  return (
    <div className={styles.page}>
      <h1 className={styles.heading}>{load.puzzle.meta.title || "Untitled"}</h1>
      {load.puzzle.meta.author && <p className={styles.byline}>{load.puzzle.meta.author}</p>}
      <button
        type="button"
        className={styles.button}
        onClick={() => handleGenerate(load.puzzle)}
        disabled={busy}
      >
        {busy ? "Generating…" : "Generate PDF"}
      </button>
      {genError && <p className={styles.error}>Couldn't generate PDF: {genError}</p>}
    </div>
  );
}
