import { useCallback, useEffect, useRef, useState } from "react";
import type { PuzzleState } from "@crossplay/shared";
import { HttpError, fetchBoard } from "./api";
import { boardPath, navigate, useRoute } from "./routing";
import type { PuzzleActions } from "./puzzleActions";
import { FeedbackBar } from "./components/FeedbackBar";
import { HomePage } from "./components/HomePage";
import { Menu } from "./components/Menu";
import { ModeButton } from "./components/ModeButton";
import { SiteIcon } from "./components/SiteIcon";
import { UploadForm } from "./components/UploadForm";
import { PuzzleView, type ActiveClue, type Mode } from "./components/PuzzleView";
import type { Feedback } from "./feedback";
import styles from "./App.module.css";

type LoadState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "loaded"; puzzle: PuzzleState }
  | { kind: "error"; message: string };

/**
 * Top-level component. Owns:
 *  - the route (home vs puzzle, via the hand-rolled router in routing.ts);
 *  - the load state for the current puzzle;
 *  - pen/pencil mode (here, not in PuzzleView, so the always-visible
 *    ModeButton in the header re-renders on toggle);
 *  - the header feedback bar with its auto-vanish timer.
 *
 * Renders either HomePage (no puzzle) or PuzzleView (loaded). The Menu
 * reads its actions from a ref written by PuzzleView; see puzzleActions.ts.
 */
export function App() {
  const route = useRoute();
  const [load, setLoad] = useState<LoadState>({ kind: "idle" });
  const [menuOpen, setMenuOpen] = useState(false);
  const [activeClue, setActiveClue] = useState<ActiveClue | null>(null);
  const [mode, setMode] = useState<Mode>("pen");
  // Persisted across sessions: collapse-rebuses preference. Display
  // only — server-side fills stay full. localStorage read is wrapped
  // because SSR / privacy modes can throw on access.
  const [collapseRebus, setCollapseRebus] = useState<boolean>(() => {
    try {
      return window.localStorage.getItem("collapseRebus") === "1";
    } catch {
      return false;
    }
  });
  const toggleCollapseRebus = useCallback(() => {
    setCollapseRebus((v) => {
      const next = !v;
      try {
        window.localStorage.setItem("collapseRebus", next ? "1" : "0");
      } catch {
        // ignore: read-only storage just means we don't persist
      }
      return next;
    });
  }, []);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const feedbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onActiveClueChange = useCallback((c: ActiveClue | null) => setActiveClue(c), []);
  const onToggleMode = useCallback(
    () => setMode((m) => (m === "pen" ? "pencil" : "pen")),
    [],
  );
  const dismissFeedback = useCallback(() => {
    if (feedbackTimerRef.current) {
      clearTimeout(feedbackTimerRef.current);
      feedbackTimerRef.current = null;
    }
    setFeedback(null);
  }, []);

  const showFeedback = useCallback((f: Feedback) => {
    if (feedbackTimerRef.current) clearTimeout(feedbackTimerRef.current);
    setFeedback(f);
    if (f.autoVanishMs && f.autoVanishMs > 0) {
      feedbackTimerRef.current = setTimeout(() => {
        feedbackTimerRef.current = null;
        setFeedback((cur) => (cur && cur.id === f.id ? null : cur));
      }, f.autoVanishMs);
    }
  }, []);

  useEffect(() => {
    return () => {
      if (feedbackTimerRef.current) clearTimeout(feedbackTimerRef.current);
    };
  }, []);
  const actionsRef = useRef<PuzzleActions | null>(null);
  const titleRef = useRef<HTMLHeadingElement | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function loadById(id: string) {
      setLoad({ kind: "loading" });
      try {
        const p = await fetchBoard(id);
        if (!cancelled) {
          // Dev-only: dump the board the server handed us so the
          // network response can be inspected without DevTools. The
          // `import.meta.env.DEV` check is statically replaced at
          // build time, so this block is dead-code-eliminated from
          // production bundles.
          if (import.meta.env.DEV) {
            // eslint-disable-next-line no-console
            console.log("[crossplay] board loaded", id, p);
          }
          setLoad({ kind: "loaded", puzzle: p });
        }
      } catch (err) {
        if (cancelled) return;
        if (err instanceof HttpError && err.status === 404) {
          navigate("/");
          return;
        }
        setLoad({
          kind: "error",
          message: err instanceof Error ? err.message : "failed to load",
        });
      }
    }

    if (route.kind === "board") {
      void loadById(route.id);
    } else {
      setLoad({ kind: "idle" });
    }

    return () => {
      cancelled = true;
    };
  }, [route]);

  // close menu / clear active clue / reset mode when puzzle changes.
  // Show the welcome feedback once per browser (localStorage flag);
  // returning users have learned where the menu is. When real users
  // exist, this should move from per-browser to per-user.
  useEffect(() => {
    setMenuOpen(false);
    setActiveClue(null);
    setMode("pen");
    if (load.kind === "loaded") {
      let seen = false;
      try {
        seen = window.localStorage.getItem("seenWelcome") === "1";
      } catch {
        // ignore: privacy-mode storage just means we re-show
      }
      if (!seen) {
        showFeedback({
          id: `welcome-${load.puzzle.meta.id}`,
          // Red heart matches the SiteIcon in the title; ⌥ is the
          // standard Mac Option-key glyph (U+2325). Both render as
          // inline characters — no SVG to load, no asset to ship.
          text: (
            <>
              Click <span style={{ color: "#dc2626" }}>♥</span>/⌥M for menu
            </>
          ),
          level: "info",
        });
        try {
          window.localStorage.setItem("seenWelcome", "1");
        } catch {
          // ignore: read-only storage just means we'll show it again next load
        }
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load.kind === "loaded" ? load.puzzle.meta.id : null]);

  function onUploaded(boardId: string) {
    navigate(boardPath(boardId));
  }

  function onNewGame() {
    setLoad({ kind: "idle" });
    setMenuOpen(false);
    setActiveClue(null);
    navigate("/");
  }

  // Home page (`load.kind === "idle"`) gets its own hero header inside
  // HomePage — no shared top bar, no menu, no welcome feedback there.
  // The board route keeps the small top-left title + menu + feedback slot.
  const showHeader = load.kind !== "idle";

  return (
    <div className={styles.app}>
      {showHeader && (
        <header className={styles.header}>
          <div className={styles.titleWrap}>
            <h1
              ref={titleRef}
              className={styles.title}
              onClick={() => setMenuOpen((o) => !o)}
            >
              <SiteIcon className={styles.icon} />
              <span className={styles.titleText}>Crossplay</span>
            </h1>
            {menuOpen && (
              <Menu
                actions={actionsRef.current}
                triggerRef={titleRef}
                onNewGame={onNewGame}
                onClose={() => setMenuOpen(false)}
              />
            )}
          </div>
          {load.kind === "loaded" && <ModeButton mode={mode} onToggle={onToggleMode} />}
          <div className={styles.headerSlot}>
            {feedback ? (
              <FeedbackBar feedback={feedback} onDismiss={dismissFeedback} />
            ) : (
              <div className={styles.activeClue}>
                {activeClue ? (
                  <>
                    <span className={styles.activeClueLabel}>
                      {activeClue.number}
                      {activeClue.direction === "across" ? "A" : "D"}
                    </span>
                    <span className={styles.activeClueText}>{activeClue.text}</span>
                  </>
                ) : (
                  <span>&nbsp;</span>
                )}
              </div>
            )}
          </div>
        </header>
      )}
      <main className={styles.main}>
        {load.kind === "loading" && <p>Loading…</p>}
        {load.kind === "error" && (
          <div>
            <p style={{ color: "#c00" }}>{load.message}</p>
            <UploadForm onUploaded={onUploaded} />
          </div>
        )}
        {load.kind === "loaded" && (
          <PuzzleView
            puzzle={load.puzzle}
            mode={mode}
            onToggleMode={onToggleMode}
            collapseRebus={collapseRebus}
            onToggleCollapseRebus={toggleCollapseRebus}
            actionsRef={actionsRef}
            onActiveClueChange={onActiveClueChange}
            onFeedback={showFeedback}
            onActivity={dismissFeedback}
            feedbackVisible={feedback != null}
            onToggleMenu={() => setMenuOpen((o) => !o)}
            onNewGame={onNewGame}
          />
        )}
        {load.kind === "idle" && <HomePage onUploaded={onUploaded} />}
      </main>
    </div>
  );
}
