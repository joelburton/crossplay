import { useCallback, useEffect, useRef, useState } from "react";
import type { PuzzleState } from "@crossplay/shared";
import { HttpError, fetchPuzzle } from "./api";
import { navigate, puzzlePath, useRoute } from "./routing";
import type { PuzzleActions } from "./puzzleActions";
import { Menu } from "./components/Menu";
import { NoteDialog } from "./components/NoteDialog";
import { UploadForm } from "./components/UploadForm";
import { PuzzleView, type ActiveClue } from "./components/PuzzleView";
import styles from "./App.module.css";

type LoadState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "loaded"; puzzle: PuzzleState }
  | { kind: "error"; message: string };

export function App() {
  const route = useRoute();
  const [load, setLoad] = useState<LoadState>({ kind: "idle" });
  const [menuOpen, setMenuOpen] = useState(false);
  const [notesOpen, setNotesOpen] = useState(false);
  const [activeClue, setActiveClue] = useState<ActiveClue | null>(null);
  const onActiveClueChange = useCallback((c: ActiveClue | null) => setActiveClue(c), []);
  const onShowNotes = useCallback(() => setNotesOpen(true), []);
  const triedDev = useRef(false);
  const actionsRef = useRef<PuzzleActions | null>(null);
  const titleRef = useRef<HTMLHeadingElement | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function loadById(id: string) {
      setLoad({ kind: "loading" });
      try {
        const p = await fetchPuzzle(id);
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

    if (route.kind === "puzzle") {
      void loadById(route.id);
    } else {
      if (triedDev.current) {
        setLoad({ kind: "idle" });
        return;
      }
      triedDev.current = true;
      setLoad({ kind: "loading" });
      fetchPuzzle("dev")
        .then((p) => {
          if (cancelled) return;
          history.replaceState({}, "", puzzlePath("dev"));
          setLoad({ kind: "loaded", puzzle: p });
        })
        .catch(() => {
          if (!cancelled) setLoad({ kind: "idle" });
        });
    }

    return () => {
      cancelled = true;
    };
  }, [route]);

  // close menu / notes / clear active clue when puzzle changes
  useEffect(() => {
    setMenuOpen(false);
    setNotesOpen(false);
    setActiveClue(null);
  }, [load.kind === "loaded" ? load.puzzle.meta.id : null]);

  function onUploaded(id: string) {
    navigate(puzzlePath(id));
  }

  function onUploadAnother() {
    triedDev.current = true;
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
            Crossplay
          </h1>
          {menuOpen && (
            <Menu
              actions={actionsRef.current}
              triggerRef={titleRef}
              onUploadAnother={onUploadAnother}
              onShowNotes={onShowNotes}
              onClose={() => setMenuOpen(false)}
            />
          )}
        </div>
        {activeClue && (
          <div className={styles.activeClue}>
            <span className={styles.activeClueLabel}>
              {activeClue.number}
              {activeClue.direction === "across" ? "A" : "D"}
            </span>
            <span className={styles.activeClueText}>{activeClue.text}</span>
          </div>
        )}
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
            actionsRef={actionsRef}
            onShowNotes={onShowNotes}
            onActiveClueChange={onActiveClueChange}
          />
        )}
        {load.kind === "idle" && <UploadForm onUploaded={onUploaded} />}
      </main>
      {notesOpen && load.kind === "loaded" && load.puzzle.meta.note && (
        <NoteDialog
          title={load.puzzle.meta.title || "Notes"}
          note={load.puzzle.meta.note}
          onClose={() => setNotesOpen(false)}
        />
      )}
    </div>
  );
}
