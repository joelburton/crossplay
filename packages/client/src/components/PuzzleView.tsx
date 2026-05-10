import { useCallback, useEffect, useMemo, useState } from "react";
import type { MutableRefObject } from "react";
import type { Cell, ClientMessage, GridSnapshot, PuzzleState } from "@crossplay/shared";
import type { Direction } from "@crossplay/shared";
import {
  type ArrowKey,
  type Cursor,
  activeClueNumber,
  advanceAfterFill,
  findCellByNumber,
  firstOpenCell,
  jumpClue,
  moveCursor,
  retreatForBackspace,
  wordCells,
} from "../cursor";
import { type ChatLine, usePuzzleSocket } from "../usePuzzleSocket";
import { type ChatIdentity, readChatIdentity } from "../chatIdentity";
import type { PuzzleActions } from "../puzzleActions";
import { Board } from "./Board";
import { ChatPanel } from "./ChatPanel";
import { ClueList } from "./ClueList";
import styles from "./PuzzleView.module.css";

export type ActiveClue = {
  number: number;
  direction: "across" | "down";
  text: string;
};

type Props = {
  puzzle: PuzzleState;
  actionsRef?: MutableRefObject<PuzzleActions | null>;
  onShowNotes?: () => void;
  onActiveClueChange?: (clue: ActiveClue | null) => void;
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
  if (cell.fill === letter && !cell.wrong) return cells;
  const next = cells.slice();
  const nextRow = next[row]!.slice();
  const updated: Cell = { kind: "cell", number: cell.number, fill: letter };
  if (cell.revealed) updated.revealed = true;
  nextRow[col] = updated;
  next[row] = nextRow;
  return next;
}

function replaceCell(
  cells: Cell[][],
  row: number,
  col: number,
  cell: Cell,
): Cell[][] {
  const existing = cells[row]?.[col];
  if (!existing) return cells;
  const next = cells.slice();
  const nextRow = next[row]!.slice();
  nextRow[col] = cell;
  next[row] = nextRow;
  return next;
}

export function PuzzleView({ puzzle, actionsRef, onShowNotes, onActiveClueChange }: Props) {
  const { meta } = puzzle;
  const [snapshot, setSnapshot] = useState<GridSnapshot>(puzzle.snapshot);
  const cells = snapshot.cells;

  const [cursor, setCursor] = useState<Cursor>(() => {
    const start = firstOpenCell(puzzle.snapshot.cells) ?? { row: 0, col: 0 };
    return { ...start, dir: "across" };
  });

  const [identity] = useState<ChatIdentity>(() => readChatIdentity());
  const [chatOpen, setChatOpen] = useState(false);
  const [chatMessages, setChatMessages] = useState<ChatLine[]>([]);

  const { state: connState, send } = usePuzzleSocket(meta.id, {
    onSnapshot: useCallback((snap: GridSnapshot) => {
      setSnapshot(snap);
    }, []),
    onCellUpdate: useCallback((row, col, cell, version) => {
      setSnapshot((prev) => {
        if (version <= prev.version) return prev;
        return { version, cells: replaceCell(prev.cells, row, col, cell) };
      });
    }, []),
    onChatMessage: useCallback((line: ChatLine) => {
      setChatMessages((prev) => [...prev, line]);
    }, []),
  });

  const sendChat = useCallback(
    (text: string) => {
      send({ type: "chat", name: identity.name, color: identity.color, text });
    },
    [send, identity.name, identity.color],
  );

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

  const onClueClick = useCallback(
    (number: number, direction: Direction) => {
      const pos = findCellByNumber(cells, number);
      if (!pos) return;
      setCursor({ row: pos.row, col: pos.col, dir: direction });
    },
    [cells],
  );

  useEffect(() => {
    if (!actionsRef) return;
    const sendMsg = (msg: ClientMessage) => send(msg);
    actionsRef.current = {
      meta,
      clearBoard: () => sendMsg({ type: "clear" }),
      revealLetter: () =>
        sendMsg({ type: "reveal", scope: "letter", row: cursor.row, col: cursor.col }),
      revealWord: () =>
        sendMsg({
          type: "reveal",
          scope: "word",
          row: cursor.row,
          col: cursor.col,
          dir: cursor.dir,
        }),
      revealPuzzle: () => sendMsg({ type: "reveal", scope: "puzzle" }),
      checkLetter: () =>
        sendMsg({ type: "check", scope: "letter", row: cursor.row, col: cursor.col }),
      checkWord: () =>
        sendMsg({
          type: "check",
          scope: "word",
          row: cursor.row,
          col: cursor.col,
          dir: cursor.dir,
        }),
      checkPuzzle: () => sendMsg({ type: "check", scope: "puzzle" }),
    };
    return () => {
      if (actionsRef.current?.meta.id === meta.id) {
        actionsRef.current = null;
      }
    };
  });

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      // Don't intercept anything when an input/textarea has focus
      // (chat input, future search boxes, etc.).
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;

      // "/" opens the chat panel.
      if (e.key === "/" && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        setChatOpen(true);
        return;
      }

      // Option/Alt + letter shortcuts. Use e.code so Mac dead-key
      // remapping (Opt+R = ®) doesn't break us.
      if (e.altKey && !e.metaKey && !e.ctrlKey) {
        if (e.code === "KeyR") {
          e.preventDefault();
          if (e.shiftKey) {
            send({
              type: "reveal",
              scope: "word",
              row: cursor.row,
              col: cursor.col,
              dir: cursor.dir,
            });
          } else {
            send({ type: "reveal", scope: "letter", row: cursor.row, col: cursor.col });
          }
          return;
        }
        if (e.code === "KeyC") {
          e.preventDefault();
          if (e.shiftKey) {
            send({
              type: "check",
              scope: "word",
              row: cursor.row,
              col: cursor.col,
              dir: cursor.dir,
            });
          } else {
            send({ type: "check", scope: "letter", row: cursor.row, col: cursor.col });
          }
          return;
        }
        if (e.code === "KeyN") {
          e.preventDefault();
          if (meta.note) onShowNotes?.();
          return;
        }
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
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

  const activeClue: ActiveClue | null = useMemo(() => {
    const num = cursor.dir === "across" ? acrossNumber : downNumber;
    if (num == null) return null;
    const list = cursor.dir === "across" ? meta.clues.across : meta.clues.down;
    const found = list.find((c) => c.number === num);
    if (!found) return null;
    return { number: found.number, direction: cursor.dir, text: found.text };
  }, [cursor.dir, acrossNumber, downNumber, meta.clues.across, meta.clues.down]);

  useEffect(() => {
    onActiveClueChange?.(activeClue);
  }, [activeClue, onActiveClueChange]);

  return (
    <div className={styles.wrap}>
      {connState !== "open" && (
        <div className={styles.conn}>
          {connState === "connecting" ? "connecting…" : "disconnected"}
        </div>
      )}
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
            direction="across"
            clues={meta.clues.across}
            activeNumber={cursor.dir === "across" ? acrossNumber : null}
            secondaryNumber={cursor.dir === "down" ? acrossNumber : null}
            onClueClick={onClueClick}
          />
          <ClueList
            title="Down"
            direction="down"
            clues={meta.clues.down}
            activeNumber={cursor.dir === "down" ? downNumber : null}
            secondaryNumber={cursor.dir === "across" ? downNumber : null}
            onClueClick={onClueClick}
          />
        </div>
      </div>
      {chatOpen && (
        <ChatPanel
          identity={identity}
          messages={chatMessages}
          onSend={sendChat}
          onClose={() => setChatOpen(false)}
        />
      )}
    </div>
  );
}
