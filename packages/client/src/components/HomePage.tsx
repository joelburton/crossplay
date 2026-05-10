import { useEffect, useState } from "react";
import {
  type BoardSummary,
  type PuzzleSummary,
  createBoard,
  fetchBoards,
  fetchPuzzles,
} from "../api";
import { boardPath, navigate } from "../routing";
import { UploadForm } from "./UploadForm";
import styles from "./HomePage.module.css";

type Props = {
  onUploaded: (boardId: string) => void;
};

/**
 * Landing page when no board is open. Three sections:
 *   - "Community puzzles": curated library, hidden if empty (only Joel
 *     curates it via the CLI; an empty list isn't actionable for users).
 *   - "Your games": in-progress boards, ALWAYS shown — empty state
 *     points the user back at the puzzles section.
 *   - "Upload your own": ad-hoc upload that creates a board directly.
 *
 * Both fetches fall through to `[]` on failure rather than surfacing an
 * error — the upload form keeps the page useful either way.
 */
export function HomePage({ onUploaded }: Props) {
  const [puzzles, setPuzzles] = useState<PuzzleSummary[] | null>(null);
  const [boards, setBoards] = useState<BoardSummary[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchPuzzles()
      .then((list) => !cancelled && setPuzzles(list))
      .catch(() => !cancelled && setPuzzles([]));
    fetchBoards()
      .then((list) => !cancelled && setBoards(list))
      .catch(() => !cancelled && setBoards([]));
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className={styles.outer}>
      <div className={styles.wrap}>
        {puzzles && puzzles.length > 0 && (
          <section className={styles.section}>
            <h2 className={styles.heading}>Community puzzles</h2>
            <ul className={styles.games}>
              {puzzles.map((p) => (
                <li key={p.id}>
                  <button
                    type="button"
                    className={styles.game}
                    onClick={() => {
                      // Find-or-create the board for this puzzle, then go play it.
                      // Failures fall through silently — the user can click again.
                      void createBoard(p.id).then(({ boardId }) => navigate(boardPath(boardId)));
                    }}
                  >
                    <span className={styles.gameTitle}>{p.title || "Untitled"}</span>
                    <span className={styles.gameMeta}>
                      {p.author && <span>by {p.author}</span>}
                      <span className={styles.gameSize}>
                        {p.width}×{p.height}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}
        <section className={styles.section}>
          <h2 className={styles.heading}>Your games</h2>
          {boards && boards.length > 0 ? (
            <ul className={styles.games}>
              {boards.map((b) => (
                <li key={b.id}>
                  <button
                    type="button"
                    className={styles.game}
                    onClick={() => navigate(boardPath(b.id))}
                  >
                    <span className={styles.gameTitle}>{b.title || "Untitled"}</span>
                    <span className={styles.gameMeta}>
                      {b.author && <span>by {b.author}</span>}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className={styles.empty}>
              No games yet. Click a puzzle to start one.
            </p>
          )}
        </section>
        <section className={styles.section}>
          <h2 className={styles.heading}>Upload your own</h2>
          <UploadForm onUploaded={onUploaded} />
        </section>
      </div>
      <footer className={styles.footer}>
        Copyright © 2026 by{" "}
        <a href="https://github.com/joelburton" target="_blank" rel="noopener noreferrer">
          Joel Burton
        </a>{" "}
        ·{" "}
        <a
          href="https://github.com/joelburton/crossplay"
          target="_blank"
          rel="noopener noreferrer"
        >
          Source
        </a>{" "}
        · AGPL-3.0
      </footer>
    </div>
  );
}
