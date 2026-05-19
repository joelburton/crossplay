import { useEffect, useRef, useState } from "react";
import {
  type AuthUser,
  type BoardSummary,
  type PuzzleSummary,
  createBoard,
  deleteBoard,
  fetchBoards,
  fetchPuzzles,
} from "../api";
import { boardPath, navigate } from "../routing";
import { formatRelative } from "../relativeTime";
import { NytFetchForm } from "./NytFetchForm";
import { SiteIcon } from "./SiteIcon";
import { UploadForm } from "./UploadForm";
import { UserMenu } from "./UserMenu";
import styles from "./HomePage.module.css";

type Props = {
  onUploaded: (boardId: string) => void;
  /** Logged-in user. Always set at the moment we render — App only
   *  mounts HomePage when auth.kind === "user". */
  user: AuthUser;
  /** Log out + return to landing page. Provided by App so HomePage
   *  doesn't have to know the routing details. */
  onLogout: () => void;
};

function formatFillPercent(pct: number | null): string {
  if (pct === null) return "NEW";
  return `${pct}%`;
}

/** Case-insensitive substring match against title + author + copyright.
 *  Copyright is in the haystack so a player can type "times" to find
 *  every NYT puzzle, etc. Both lists share the predicate so they feel
 *  consistent. */
function matchesQuery(
  item: { title: string; author: string; copyright: string },
  q: string,
): boolean {
  if (!q) return true;
  const needle = q.toLowerCase();
  return (
    item.title.toLowerCase().includes(needle) ||
    item.author.toLowerCase().includes(needle) ||
    item.copyright.toLowerCase().includes(needle)
  );
}

/**
 * Landing page when no board is open. Three sections:
 *   - "Puzzle library": curated library, hidden if empty (only Joel
 *     curates it via the CLI; an empty list isn't actionable for users).
 *   - "Your games": in-progress boards, ALWAYS shown — empty state
 *     points the user back at the puzzles section.
 *   - "Upload your own": ad-hoc upload that creates a board directly.
 *
 * Both fetches fall through to `[]` on failure rather than surfacing an
 * error — the upload form keeps the page useful either way.
 */
export function HomePage({ onUploaded, user, onLogout }: Props) {
  const [puzzles, setPuzzles] = useState<PuzzleSummary[] | null>(null);
  const [boards, setBoards] = useState<BoardSummary[] | null>(null);
  // Set when one or both list fetches fail (e.g. dev server isn't
  // running). Surfaced as a single banner — better than silently
  // rendering empty lists that look like "no games yet".
  const [loadError, setLoadError] = useState<string | null>(null);
  // Two-step delete: null = trash icon only, <id> = that row is in
  // "Delete?" confirm state. At most one row is in confirm state at a
  // time; clicking outside the confirm button OR pressing Esc cancels.
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  // While a DELETE is in flight we hide the row entirely so the user
  // can't click it and navigate to a board that's about to vanish.
  const [deletingIds, setDeletingIds] = useState<Set<string>>(() => new Set());
  const confirmButtonRef = useRef<HTMLButtonElement | null>(null);
  // Pure client-side filters — at the expected library size (~hundreds)
  // a substring match per keystroke is free. Server-side filtering
  // would cost a request round-trip + debouncing for no benefit.
  const [puzzleFilter, setPuzzleFilter] = useState("");
  const [boardFilter, setBoardFilter] = useState("");

  useEffect(() => {
    let cancelled = false;
    const failed = () => {
      if (cancelled) return;
      setLoadError("Couldn't reach the server. Refresh to try again.");
    };
    fetchPuzzles()
      .then((list) => !cancelled && setPuzzles(list))
      .catch(() => {
        if (cancelled) return;
        setPuzzles([]);
        failed();
      });
    fetchBoards()
      .then((list) => !cancelled && setBoards(list))
      .catch(() => {
        if (cancelled) return;
        setBoards([]);
        failed();
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // While a row is in confirm state, a click anywhere except the
  // confirm button itself cancels it. mousedown (not click) so the
  // dismissal happens before any other element's click handler can
  // run, which keeps the UX predictable. Esc dismisses too — the same
  // dismissal channel for keyboard users.
  useEffect(() => {
    if (confirmDeleteId === null) return;
    function onDocumentMouseDown(e: MouseEvent) {
      const btn = confirmButtonRef.current;
      if (btn && e.target instanceof Node && btn.contains(e.target)) return;
      setConfirmDeleteId(null);
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setConfirmDeleteId(null);
    }
    document.addEventListener("mousedown", onDocumentMouseDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onDocumentMouseDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [confirmDeleteId]);

  async function onConfirmDelete(id: string) {
    setConfirmDeleteId(null);
    setDeletingIds((cur) => {
      const next = new Set(cur);
      next.add(id);
      return next;
    });
    try {
      await deleteBoard(id);
      setBoards((cur) => (cur ? cur.filter((b) => b.id !== id) : cur));
    } catch {
      // No surfaced error UI here — re-fetch so the list reflects truth
      // (e.g. the row may have been deleted elsewhere already).
      fetchBoards()
        .then(setBoards)
        .catch(() => {});
    } finally {
      setDeletingIds((cur) => {
        const next = new Set(cur);
        next.delete(id);
        return next;
      });
    }
  }

  return (
    <div className={styles.outer}>
      {/* Top-right dropdown — same `UserMenu` used on the board page.
          Fixed-positioned by its own CSS, so no wrapper needed.
          Today the only item is "Log out"; future account actions
          (Preferences, Change password, …) slot in here. */}
      <UserMenu handle={user.handle} onLogout={onLogout} />
      <div className={styles.hero}>
        <SiteIcon className={styles.heroIcon} />
        <h1 className={styles.heroTitle}>Crossplay</h1>
      </div>
      {loadError && <div className={styles.loadError}>{loadError}</div>}
      <div className={styles.wrap}>
        {puzzles && puzzles.length > 0 && (() => {
          const filtered = puzzles.filter((p) => matchesQuery(p, puzzleFilter));
          return (
            <section className={`${styles.section} ${styles.listSection}`}>
              <h2 className={styles.heading}>Puzzle library</h2>
              <input
                type="search"
                className={styles.filter}
                placeholder="Filter puzzles…"
                value={puzzleFilter}
                onChange={(e) => setPuzzleFilter(e.target.value)}
                aria-label="Filter puzzle library"
              />
              {filtered.length > 0 ? (
                <ul className={styles.games}>
                  {filtered.map((p) => (
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
                        {p.copyright && (
                          <span className={styles.gameCopyright}>{p.copyright}</span>
                        )}
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className={styles.empty}>No puzzles match that filter.</p>
              )}
            </section>
          );
        })()}
        <section className={`${styles.section} ${styles.listSection}`}>
          <h2 className={styles.heading}>Your games</h2>
          {(() => {
            // Hide rows whose DELETE is in flight so the user can't
            // click them mid-flight and navigate to a vanishing board.
            const visible = boards?.filter((b) => !deletingIds.has(b.id)) ?? null;
            const hasAny = visible !== null && visible.length > 0;
            const filtered = hasAny
              ? visible!.filter((b) => matchesQuery(b, boardFilter))
              : [];
            return (
              <>
                {/* Filter input only when there's something to filter — an
                    empty list with a filter input above its empty-state
                    copy reads as broken. */}
                {hasAny && (
                  <input
                    type="search"
                    className={styles.filter}
                    placeholder="Filter your games…"
                    value={boardFilter}
                    onChange={(e) => setBoardFilter(e.target.value)}
                    aria-label="Filter your games"
                  />
                )}
                {!hasAny ? (
                  <p className={styles.empty}>
                    No games yet. Click a puzzle to start one.
                  </p>
                ) : filtered.length === 0 ? (
                  <p className={styles.empty}>No games match that filter.</p>
                ) : (
                  <ul className={styles.games}>
                    {filtered.map((b) => {
                      const isConfirming = confirmDeleteId === b.id;
                      return (
                        <li key={b.id} className={styles.boardRow}>
                          <button
                            type="button"
                            className={styles.game}
                            onClick={() => navigate(boardPath(b.id))}
                          >
                            <span className={styles.gameTitle}>{b.title || "Untitled"}</span>
                            <span className={styles.gameMeta}>
                              {b.author && <span>by {b.author}</span>}
                            </span>
                            {b.copyright && (
                              <span className={styles.gameCopyright}>{b.copyright}</span>
                            )}
                            {b.members.length > 0 && (
                              <span className={styles.gameMembers}>
                                Playing with {b.members.join(", ")}
                              </span>
                            )}
                            <span className={styles.gameStatus}>
                              <span>{formatRelative(b.updatedAt)}</span>
                              <span className={styles.statusBullet} aria-hidden="true">
                                •
                              </span>
                              <span>{formatFillPercent(b.fillPercent)}</span>
                              {b.isLive && (
                                <>
                                  <span className={styles.statusBullet} aria-hidden="true">
                                    •
                                  </span>
                                  <span className={styles.liveBadge}>
                                    <span className={styles.liveDot} aria-hidden="true">
                                      ●
                                    </span>
                                    live
                                  </span>
                                </>
                              )}
                            </span>
                          </button>
                          {isConfirming ? (
                            <button
                              ref={confirmButtonRef}
                              type="button"
                              className={styles.deleteConfirm}
                              onClick={() => void onConfirmDelete(b.id)}
                              aria-label={`Confirm delete ${b.title || "board"}`}
                            >
                              Delete?
                            </button>
                          ) : (
                            <button
                              type="button"
                              className={styles.deleteIcon}
                              onClick={() => setConfirmDeleteId(b.id)}
                              aria-label={`Delete ${b.title || "board"}`}
                              title="Delete this game"
                            >
                              ×
                            </button>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </>
            );
          })()}
        </section>
        <section className={`${styles.section} ${styles.uploadSection}`}>
          <h2 className={styles.heading}>Upload your own</h2>
          <UploadForm onUploaded={onUploaded} />
          <p className={styles.uploadHint}>
            Uploaded puzzles show up in <em>Your games</em> for you to keep playing.
            They aren&rsquo;t added to the <em>Puzzle library</em>, which is curated.
          </p>
          {user.hasNytCookie && <NytFetchForm onFetched={onUploaded} />}
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
