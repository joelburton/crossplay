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
        if (!cancelled) setLoad({ kind: "loaded", puzzle: p });
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

  // close menu / clear active clue / reset mode when puzzle changes
  // Also: show the welcome feedback every time a puzzle loads.
  useEffect(() => {
    setMenuOpen(false);
    setActiveClue(null);
    setMode("pen");
    if (load.kind === "loaded") {
      showFeedback({
        id: `welcome-${load.puzzle.meta.id}`,
        text: "Welcome! Click the heart for a menu.",
        level: "info",
      });
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

  return (
    <div className={styles.app}>
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
          ) : activeClue ? (
            <div className={styles.activeClue}>
              <span className={styles.activeClueLabel}>
                {activeClue.number}
                {activeClue.direction === "across" ? "A" : "D"}
              </span>
              <span className={styles.activeClueText}>{activeClue.text}</span>
            </div>
          ) : null}
        </div>
      </header>
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
          />
        )}
        {load.kind === "idle" && <HomePage onUploaded={onUploaded} />}
      </main>
    </div>
  );
}
