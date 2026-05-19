/**
 * Print view of a board. Lives at `/b/:id/print`, opened in a new tab
 * by the menu's "Print / Save as PDF" item.
 *
 * Fetches the board, then offers two PDFs:
 *   - Puzzle PDF (title + grid + clues) — built from the board fetch
 *     alone.
 *   - Solution PDF (title + filled grid + notes) — lazily fetches
 *     `/boards/:id/solution` on click; useful as a cryptic-style
 *     answer key with wordplay explanations in `meta.note`.
 *
 * Both buttons lazy-import the jsPDF-based print module, build a Blob,
 * and trigger a download — the browser saves it and the user opens
 * it from their downloads. (We used to open the blob in a new tab,
 * but that gets blocked / backgrounded on Safari and Firefox.)
 * See docs/print-pdf-plan.md.
 */

import { useEffect, useState } from "react";
import type { PuzzleState } from "@crossplay/shared";
import { fetchBoard, fetchBoardSolution, HttpError } from "../api";
import styles from "./PrintPage.module.css";

type LoadState =
  | { kind: "loading" }
  | { kind: "loaded"; puzzle: PuzzleState }
  | { kind: "error"; message: string };

type BusyKind = "puzzle" | "solution" | null;

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function pdfFilename(title: string, suffix: "puzzle" | "solution") {
  const base = title.trim().replace(/[\\/:*?"<>|]+/g, "").replace(/\s+/g, " ").trim() || "crossword";
  return `${base} — ${suffix}.pdf`;
}

export function PrintPage({ boardId }: { boardId: string }) {
  const [load, setLoad] = useState<LoadState>({ kind: "loading" });
  const [busy, setBusy] = useState<BusyKind>(null);
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

  async function handleGeneratePuzzle(puzzle: PuzzleState) {
    setBusy("puzzle");
    setGenError(null);
    try {
      const { generateCrosswordPdf } = await import("../print");
      const blob = await generateCrosswordPdf(puzzle);
      downloadBlob(blob, pdfFilename(puzzle.meta.title, "puzzle"));
    } catch (err) {
      setGenError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function handleGenerateSolution(puzzle: PuzzleState) {
    setBusy("solution");
    setGenError(null);
    try {
      const [{ generateSolutionPdf }, { solution }] = await Promise.all([
        import("../print"),
        fetchBoardSolution(boardId),
      ]);
      const blob = await generateSolutionPdf(puzzle, solution);
      downloadBlob(blob, pdfFilename(puzzle.meta.title, "solution"));
    } catch (err) {
      setGenError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  if (load.kind === "loading") return <p className={styles.status}>Loading…</p>;
  if (load.kind === "error") return <p className={styles.status}>{load.message}</p>;

  return (
    <div className={styles.page}>
      <h1 className={styles.heading}>{load.puzzle.meta.title || "Untitled"}</h1>
      {load.puzzle.meta.author && <p className={styles.byline}>{load.puzzle.meta.author}</p>}
      <div className={styles.buttons}>
        <button
          type="button"
          className={styles.button}
          onClick={() => handleGeneratePuzzle(load.puzzle)}
          disabled={busy !== null}
        >
          {busy === "puzzle" ? "Generating…" : "Puzzle PDF"}
        </button>
        <button
          type="button"
          className={styles.button}
          onClick={() => handleGenerateSolution(load.puzzle)}
          disabled={busy !== null}
        >
          {busy === "solution" ? "Generating…" : "Solution PDF"}
        </button>
      </div>
      <p className={styles.hint}>
        The PDF will be saved to your Downloads folder.
      </p>
      {genError && <p className={styles.error}>Couldn't generate PDF: {genError}</p>}
    </div>
  );
}
