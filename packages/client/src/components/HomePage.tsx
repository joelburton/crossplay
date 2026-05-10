import { useEffect, useState } from "react";
import { type GameSummary, fetchGames } from "../api";
import { navigate, puzzlePath } from "../routing";
import { UploadForm } from "./UploadForm";
import styles from "./HomePage.module.css";

type Props = {
  onUploaded: (puzzleId: string) => void;
};

/**
 * Landing page when no puzzle is loaded. Two columns:
 *   - Left: scrollable list of pre-loaded library puzzles fetched from
 *     `/api/games`. Click an entry to navigate to `/p/:id`.
 *   - Right: a `.puz` file upload form.
 *
 * The library section hides itself when the fetch returns an empty
 * list (or fails — we fall through to `[]` rather than show an error,
 * since the upload form is still useful).
 */
export function HomePage({ onUploaded }: Props) {
  const [games, setGames] = useState<GameSummary[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchGames()
      .then((list) => {
        if (!cancelled) setGames(list);
      })
      .catch(() => {
        if (!cancelled) setGames([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className={styles.outer}>
      <div className={styles.wrap}>
        {games && games.length > 0 && (
          <section className={styles.section}>
            <h2 className={styles.heading}>Games</h2>
            <ul className={styles.games}>
              {games.map((g) => (
                <li key={g.id}>
                  <button
                    type="button"
                    className={styles.game}
                    onClick={() => navigate(puzzlePath(g.id))}
                  >
                    <span className={styles.gameTitle}>{g.title || "Untitled"}</span>
                    <span className={styles.gameMeta}>
                      {g.author && <span>by {g.author}</span>}
                      <span className={styles.gameSize}>
                        {g.width}×{g.height}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}
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
