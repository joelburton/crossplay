import { useCallback, useEffect, useMemo, useState } from "react";
import type { Cell, GridSnapshot, PuzzleState } from "@crossplay/shared";
import {
  type ArrowKey,
  type Cursor,
  activeClueNumber,
  advanceAfterFill,
  firstOpenCell,
  jumpClue,
  moveCursor,
  retreatForBackspace,
  wordCells,
} from "../cursor";
import { usePuzzleSocket } from "../usePuzzleSocket";
import { Board } from "./Board";
import { ClueList } from "./ClueList";
import styles from "./PuzzleView.module.css";

type Props = {
  puzzle: PuzzleState;
};

const ARROWS: ReadonlySet<string> = new Set([
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "ArrowDown",
]);

function setCellFill(
  cells: Cell[][],
  row: number,
  col: number,
  letter: string | null,
): Cell[][] {
  const cell = cells[row]?.[col];
  if (!cell || cell.kind !== "cell") return cells;
  if (cell.fill === letter) return cells;
  const next = cells.slice();
  const nextRow = next[row]!.slice();
  nextRow[col] = { ...cell, fill: letter };
  next[row] = nextRow;
  return next;
}

export function PuzzleView({ puzzle }: Props) {
  const { meta } = puzzle;
  const [snapshot, setSnapshot] = useState<GridSnapshot>(puzzle.snapshot);
  const cells = snapshot.cells;

  const [cursor, setCursor] = useState<Cursor>(() => {
    const start = firstOpenCell(puzzle.snapshot.cells) ?? { row: 0, col: 0 };
    return { ...start, dir: "across" };
  });

  const { state: connState, send } = usePuzzleSocket(meta.id, {
    onSnapshot: useCallback((snap: GridSnapshot) => {
      setSnapshot(snap);
    }, []),
    onCellUpdate: useCallback((row, col, letter, version) => {
      setSnapshot((prev) => {
        if (version <= prev.version) return prev;
        return { version, cells: setCellFill(prev.cells, row, col, letter) };
      });
    }, []),
  });

  const onCellClick = useCallback(
    (row: number, col: number) => {
      setCursor((cur) => {
        if (cur.row === row && cur.col === col) {
          return { ...cur, dir: cur.dir === "across" ? "down" : "across" };
        }
        return { row, col, dir: cur.dir };
      });
    },
    [],
  );

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (ARROWS.has(e.key)) {
        e.preventDefault();
        setCursor((cur) => moveCursor(cells, cur, e.key as ArrowKey));
        return;
      }
      if (e.key === "Tab") {
        e.preventDefault();
        setCursor((cur) => jumpClue(cells, cur, e.shiftKey ? -1 : 1));
        return;
      }
      if (/^[a-zA-Z]$/.test(e.key)) {
        e.preventDefault();
        const letter = e.key.toUpperCase();
        const { row, col } = cursor;
        setSnapshot((prev) => ({
          version: prev.version,
          cells: setCellFill(prev.cells, row, col, letter),
        }));
        send({ type: "fill", row, col, letter, clientVersion: snapshot.version });
        setCursor((cur) => advanceAfterFill(cells, cur));
        return;
      }
      if (e.key === "Backspace") {
        e.preventDefault();
        const { row, col } = cursor;
        const cell = cells[row]?.[col];
        if (cell?.kind === "cell" && cell.fill != null) {
          setSnapshot((prev) => ({
            version: prev.version,
            cells: setCellFill(prev.cells, row, col, null),
          }));
          send({ type: "fill", row, col, letter: null, clientVersion: snapshot.version });
        } else {
          const back = retreatForBackspace(cells, cursor);
          if (back.row !== cursor.row || back.col !== cursor.col) {
            setSnapshot((prev) => ({
              version: prev.version,
              cells: setCellFill(prev.cells, back.row, back.col, null),
            }));
            send({
              type: "fill",
              row: back.row,
              col: back.col,
              letter: null,
              clientVersion: snapshot.version,
            });
            setCursor(back);
          }
        }
        return;
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [cells, cursor, snapshot.version, send]);

  const highlighted = useMemo(() => {
    const set = new Set<string>();
    for (const { row, col } of wordCells(cells, cursor.row, cursor.col, cursor.dir)) {
      set.add(`${row}:${col}`);
    }
    return set;
  }, [cells, cursor]);

  const acrossNumber = activeClueNumber(cells, cursor.row, cursor.col, "across");
  const downNumber = activeClueNumber(cells, cursor.row, cursor.col, "down");

  return (
    <div className={styles.wrap}>
      <div className={styles.titleRow}>
        <h2 className={styles.title}>{meta.title || "Untitled"}</h2>
        {meta.author && <span className={styles.author}>by {meta.author}</span>}
        {connState !== "open" && (
          <span className={styles.conn}>{connState === "connecting" ? "connecting…" : "disconnected"}</span>
        )}
      </div>
      <div className={styles.layout}>
        <Board
          cells={cells}
          cursor={cursor}
          highlighted={highlighted}
          onCellClick={onCellClick}
        />
        <div className={styles.clues}>
          <ClueList
            title="Across"
            clues={meta.clues.across}
            activeNumber={cursor.dir === "across" ? acrossNumber : null}
            secondaryNumber={cursor.dir === "down" ? acrossNumber : null}
          />
          <ClueList
            title="Down"
            clues={meta.clues.down}
            activeNumber={cursor.dir === "down" ? downNumber : null}
            secondaryNumber={cursor.dir === "across" ? downNumber : null}
          />
        </div>
      </div>
    </div>
  );
}
