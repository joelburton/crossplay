import { useEffect, useRef, useState } from "react";
import type { PuzzleState } from "@crossplay/shared";
import { HttpError, fetchPuzzle } from "./api";
import { navigate, puzzlePath, useRoute } from "./routing";
import { UploadForm } from "./components/UploadForm";
import { PuzzleView } from "./components/PuzzleView";
import styles from "./App.module.css";

type LoadState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "loaded"; puzzle: PuzzleState }
  | { kind: "error"; message: string };

export function App() {
  const route = useRoute();
  const [load, setLoad] = useState<LoadState>({ kind: "idle" });
  const triedDev = useRef(false);

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
      // home
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

  function onUploaded(id: string) {
    navigate(puzzlePath(id));
  }

  function onUploadAnother() {
    triedDev.current = true;
    setLoad({ kind: "idle" });
    navigate("/");
  }

  return (
    <div className={styles.app}>
      <header className={styles.header}>
        <h1>Crossplay</h1>
        {load.kind === "loaded" && (
          <button onClick={onUploadAnother} className={styles.reset}>
            Upload another
          </button>
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
        {load.kind === "loaded" && <PuzzleView puzzle={load.puzzle} />}
        {load.kind === "idle" && <UploadForm onUploaded={onUploaded} />}
      </main>
    </div>
  );
}
