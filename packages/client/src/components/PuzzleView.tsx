import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { type ChatIdentity, makeIdentity, persistName, readChatIdentity } from "../chatIdentity";
import type { Feedback } from "../feedback";
import type { PuzzleActions } from "../puzzleActions";
import { Board, NARROW_QUERY } from "./Board";
import { ChatIndicator } from "./ChatIndicator";
import { ChatPanel } from "./ChatPanel";
import { ChatPreview } from "./ChatPreview";
import { ClueList } from "./ClueList";
import { NoteDialog } from "./NoteDialog";
import styles from "./PuzzleView.module.css";

export type ActiveClue = {
  number: number;
  direction: "across" | "down";
  text: string;
};

export type Mode = "pen" | "pencil";

type Props = {
  puzzle: PuzzleState;
  mode: Mode;
  onToggleMode: () => void;
  actionsRef?: MutableRefObject<PuzzleActions | null>;
  onActiveClueChange?: (clue: ActiveClue | null) => void;
  onFeedback?: (f: Feedback) => void;
  onActivity?: () => void;
  feedbackVisible?: boolean;
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
  pencil: boolean,
): Cell[][] {
  const cell = cells[row]?.[col];
  if (!cell || cell.kind !== "cell") return cells;
  const willPencil = letter != null && pencil;
  // Early-exit when nothing visible would change. The server echoes back
  // every fill (including ones we just optimistically wrote locally), so
  // without this guard we'd allocate a new row + grid on every echo —
  // and re-render the whole board for no visible change.
  if (
    cell.fill === letter &&
    !cell.wrong &&
    (cell.pencil ?? false) === willPencil
  ) return cells;
  const next = cells.slice();
  const nextRow = next[row]!.slice();
  const updated: Cell = { kind: "cell", number: cell.number, fill: letter };
  if (cell.revealed) updated.revealed = true;
  if (willPencil) updated.pencil = true;
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

/**
 * The central play surface. Owns:
 *  - the cursor (row/col + direction);
 *  - the live grid snapshot (mutated by both local typing and server
 *    `cellUpdate` broadcasts; "newer version wins");
 *  - the WebSocket connection (via usePuzzleSocket);
 *  - chat state (panel open, unread count, recent preview);
 *  - notes dialog state (locally dismissed, globally opened).
 *
 * Receives `mode` (pen/pencil) as a prop from App and pushes the menu's
 * available actions up via `actionsRef` so the menu can fire them without
 * subscribing to every cursor change.
 *
 * Optimistic typing is non-negotiable here: letter input renders locally
 * before any server round-trip (see CLAUDE.md "Optimistic typing").
 */
export function PuzzleView({
  puzzle,
  mode,
  onToggleMode,
  actionsRef,
  onActiveClueChange,
  onFeedback,
  onActivity,
  feedbackVisible,
}: Props) {
  const { meta } = puzzle;
  const [snapshot, setSnapshot] = useState<GridSnapshot>(puzzle.snapshot);
  const cells = snapshot.cells;

  const [cursor, setCursor] = useState<Cursor>(() => {
    const start = firstOpenCell(puzzle.snapshot.cells) ?? { row: 0, col: 0 };
    return { ...start, dir: "across" };
  });

  const [identity, setIdentity] = useState<ChatIdentity>(() => readChatIdentity());
  const identityRef = useRef(identity);
  identityRef.current = identity;
  const [chatOpen, setChatOpen] = useState(false);
  const [chatMessages, setChatMessages] = useState<ChatLine[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [unreadColor, setUnreadColor] = useState<string | null>(null);
  const [previewLine, setPreviewLine] = useState<ChatLine | null>(null);
  const [notesOpen, setNotesOpen] = useState(false);
  const [recentFills, setRecentFills] = useState<Map<string, string>>(new Map());
  const recentTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const chatOpenRef = useRef(chatOpen);
  chatOpenRef.current = chatOpen;
  const previewTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const chatInputRef = useRef<HTMLTextAreaElement | null>(null);
  const boardRef = useRef<HTMLDivElement | null>(null);
  const [chatRightPx, setChatRightPx] = useState<number | null>(null);

  // When the clues are hidden (narrow viewport), align the chat indicator
  // and preview to the board's right edge instead of the viewport's, so
  // they don't waste horizontal space outside the board. We expose this
  // as the CSS custom property `--chat-right` (px from the right viewport
  // edge); ChatIndicator.module.css and ChatPreview.module.css both read
  // it via `right: var(--chat-right, ...)`. When the variable is unset
  // (wide viewport) the modules fall back to their default offsets.
  useEffect(() => {
    const el = boardRef.current;
    if (!el) return;
    const mq = window.matchMedia(NARROW_QUERY);
    const update = () => {
      if (!mq.matches) {
        setChatRightPx(null);
        return;
      }
      const r = el.getBoundingClientRect();
      setChatRightPx(Math.max(0, Math.round(window.innerWidth - r.right)));
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    window.addEventListener("resize", update);
    mq.addEventListener("change", update);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", update);
      mq.removeEventListener("change", update);
    };
  }, []);

  useEffect(() => {
    return () => {
      if (previewTimerRef.current) clearTimeout(previewTimerRef.current);
      for (const t of recentTimersRef.current.values()) clearTimeout(t);
      recentTimersRef.current.clear();
    };
  }, []);

  const trackRecentFill = useCallback((row: number, col: number, color: string) => {
    const key = `${row}:${col}`;
    const existing = recentTimersRef.current.get(key);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      recentTimersRef.current.delete(key);
      setRecentFills((prev) => {
        const next = new Map(prev);
        next.delete(key);
        return next;
      });
    }, 3000);
    recentTimersRef.current.set(key, timer);
    setRecentFills((prev) => {
      const next = new Map(prev);
      next.set(key, color);
      return next;
    });
  }, []);

  const { state: connState, send } = usePuzzleSocket(meta.id, {
    onSnapshot: useCallback((snap: GridSnapshot) => {
      setSnapshot(snap);
    }, []),
    onCellUpdate: useCallback(
      (row, col, cell, version, senderColor) => {
        setSnapshot((prev) => {
          if (version <= prev.version) return prev;
          return { version, cells: replaceCell(prev.cells, row, col, cell) };
        });
        if (senderColor && senderColor !== identityRef.current.color) {
          trackRecentFill(row, col, senderColor);
        }
      },
      [trackRecentFill],
    ),
    onNotesShown: useCallback(() => {
      setNotesOpen(true);
    }, []),
    onFeedback: useCallback(
      (f: Feedback) => {
        onFeedback?.(f);
      },
      [onFeedback],
    ),
    onChatMessage: useCallback((line: ChatLine) => {
      setChatMessages((prev) => [...prev, line]);

      // Brief preview at top-right that auto-clears after 3s. Independent of
      // unread state — preview is purely visual and never marks as read.
      setPreviewLine(line);
      if (previewTimerRef.current) clearTimeout(previewTimerRef.current);
      previewTimerRef.current = setTimeout(() => setPreviewLine(null), 3000);

      const important = line.text.startsWith("!");
      if (important && !chatOpenRef.current) {
        // Force-open: counts as "read" since the user sees it immediately.
        setChatOpen(true);
        setUnreadCount(0);
        setUnreadColor(null);
        return;
      }
      if (!chatOpenRef.current) {
        setUnreadCount((n) => n + 1);
        setUnreadColor(line.color);
      }
    }, []),
  });

  const sendChat = useCallback(
    (text: string) => {
      send({ type: "chat", name: identity.name, color: identity.color, text });
    },
    [send, identity.name, identity.color],
  );

  // Announce ourselves whenever the socket opens (initial connect + reconnects).
  useEffect(() => {
    if (connState === "open") {
      send({ type: "hello", name: identity.name, color: identity.color });
    }
  }, [connState, send, identity.name, identity.color]);

  const renameMe = useCallback((newName: string) => {
    const next = makeIdentity(newName);
    setIdentity(next);
    persistName(next.name);
  }, []);

  const openChat = useCallback(() => {
    setChatOpen(true);
    setUnreadCount(0);
  }, []);

  const closeChat = useCallback(() => {
    setChatOpen(false);
  }, []);

  const toggleChat = useCallback(() => {
    if (chatOpenRef.current) closeChat();
    else openChat();
  }, [openChat, closeChat]);

  const onCellClick = useCallback(
    (row: number, col: number) => {
      onActivity?.();
      setCursor((cur) => {
        if (cur.row === row && cur.col === col) {
          return { ...cur, dir: cur.dir === "across" ? "down" : "across" };
        }
        return { row, col, dir: cur.dir };
      });
    },
    [onActivity],
  );

  const onClueClick = useCallback(
    (number: number, direction: Direction) => {
      onActivity?.();
      const pos = findCellByNumber(cells, number);
      if (!pos) return;
      setCursor({ row: pos.row, col: pos.col, dir: direction });
    },
    [cells, onActivity],
  );

  const triggerShowNotes = useCallback(() => {
    if (!meta.note) {
      onFeedback?.({
        id: `no-notes-${meta.id}-${Date.now()}`,
        text: "No notes for this puzzle",
        level: "info",
        autoVanishMs: 2500,
      });
      return;
    }
    setNotesOpen(true);
    send({ type: "showNotes" });
  }, [meta.note, meta.id, send, onFeedback]);

  useEffect(() => {
    if (!actionsRef) return;
    const sc = identity.color;
    const sendMsg = (msg: ClientMessage) => send(msg);
    actionsRef.current = {
      meta,
      mode,
      togglePencil: onToggleMode,
      clearBoard: () => sendMsg({ type: "clear" }),
      revealLetter: () =>
        sendMsg({
          type: "reveal",
          scope: "letter",
          row: cursor.row,
          col: cursor.col,
          senderColor: sc,
        }),
      revealWord: () =>
        sendMsg({
          type: "reveal",
          scope: "word",
          row: cursor.row,
          col: cursor.col,
          dir: cursor.dir,
          senderColor: sc,
        }),
      revealPuzzle: () => sendMsg({ type: "reveal", scope: "puzzle", senderColor: sc }),
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
      showNotes: triggerShowNotes,
      downloadIpuz: () => {
        // Anchor + click is the simplest way to honor the server's
        // Content-Disposition filename without an extra fetch.
        const a = document.createElement("a");
        a.href = `/api/puzzles/${meta.id}/ipuz`;
        a.rel = "noopener";
        document.body.appendChild(a);
        a.click();
        a.remove();
      },
    };
    return () => {
      if (actionsRef.current?.meta.id === meta.id) {
        actionsRef.current = null;
      }
    };
  }, [
    actionsRef,
    send,
    cursor.row,
    cursor.col,
    cursor.dir,
    mode,
    meta,
    identity.color,
    onToggleMode,
    triggerShowNotes,
  ]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      // Tab while chat is open: close the chat, don't navigate the grid.
      // This applies regardless of where focus is (textarea, close button,
      // or anywhere else inside the chat panel).
      if (chatOpenRef.current && e.key === "Tab") {
        e.preventDefault();
        closeChat();
        return;
      }

      // Don't intercept anything when an input/textarea has focus
      // (chat input, future search boxes, etc.).
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;

      // Esc closes the chat from anywhere outside an input/textarea.
      // (Inside the textarea, ChatPanel's own handler still does the same;
      // inside the rename input, it just cancels the rename.)
      if (chatOpenRef.current && e.key === "Escape") {
        e.preventDefault();
        closeChat();
        return;
      }

      // "/" opens the chat (or focuses its input if already open).
      if (e.key === "/" && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        if (chatOpenRef.current) {
          chatInputRef.current?.focus();
        } else {
          openChat();
        }
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
          triggerShowNotes();
          return;
        }
        if (e.code === "KeyP") {
          e.preventDefault();
          onToggleMode();
          return;
        }
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (ARROWS.has(e.key)) {
        e.preventDefault();
        onActivity?.();
        setCursor((cur) => moveCursor(cells, cur, e.key as ArrowKey));
        return;
      }
      if (e.key === "Tab") {
        e.preventDefault();
        onActivity?.();
        setCursor((cur) => jumpClue(cells, cur, e.shiftKey ? -1 : 1));
        return;
      }
      if (/^[a-zA-Z]$/.test(e.key)) {
        e.preventDefault();
        onActivity?.();
        const letter = e.key.toUpperCase();
        const { row, col } = cursor;
        const isPencil = mode === "pencil";
        setSnapshot((prev) => ({
          version: prev.version,
          cells: setCellFill(prev.cells, row, col, letter, isPencil),
        }));
        send({
          type: "fill",
          row,
          col,
          letter,
          clientVersion: snapshot.version,
          senderColor: identity.color,
          ...(isPencil ? { pencil: true } : {}),
        });
        setCursor((cur) => advanceAfterFill(cells, cur));
        return;
      }
      if (e.key === "Backspace") {
        e.preventDefault();
        onActivity?.();
        const { row, col } = cursor;
        const cell = cells[row]?.[col];
        if (cell?.kind === "cell" && cell.fill != null) {
          setSnapshot((prev) => ({
            version: prev.version,
            cells: setCellFill(prev.cells, row, col, null, false),
          }));
          send({
            type: "fill",
            row,
            col,
            letter: null,
            clientVersion: snapshot.version,
            senderColor: identity.color,
          });
        } else {
          const back = retreatForBackspace(cells, cursor);
          if (back.row !== cursor.row || back.col !== cursor.col) {
            setSnapshot((prev) => ({
              version: prev.version,
              cells: setCellFill(prev.cells, back.row, back.col, null, false),
            }));
            send({
              type: "fill",
              row: back.row,
              col: back.col,
              letter: null,
              clientVersion: snapshot.version,
              senderColor: identity.color,
            });
            setCursor(back);
          }
        }
        return;
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    cells,
    cursor,
    snapshot.version,
    send,
    mode,
    identity.color,
    triggerShowNotes,
    onActivity,
    closeChat,
    openChat,
    onToggleMode,
  ]);

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

  const wrapStyle =
    chatRightPx != null
      ? ({ ["--chat-right" as never]: `${chatRightPx}px` } as React.CSSProperties)
      : undefined;

  return (
    <div className={styles.wrap} style={wrapStyle}>
      {connState !== "open" && (
        <div className={styles.conn}>
          {connState === "connecting" ? "connecting…" : "disconnected"}
        </div>
      )}
      <div className={styles.layout}>
        <Board
          ref={boardRef}
          cells={cells}
          cursor={cursor}
          highlighted={highlighted}
          recentFills={recentFills}
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
      {previewLine && !feedbackVisible && <ChatPreview line={previewLine} />}
      <ChatIndicator
        unreadCount={unreadCount}
        unreadColor={unreadColor}
        open={chatOpen}
        onToggle={toggleChat}
      />
      {chatOpen && (
        <ChatPanel
          identity={identity}
          messages={chatMessages}
          onSend={sendChat}
          onRename={renameMe}
          onClose={closeChat}
          inputRef={chatInputRef}
        />
      )}
      {notesOpen && meta.note && (
        <NoteDialog
          title={meta.title || "Notes"}
          note={meta.note}
          onClose={() => setNotesOpen(false)}
        />
      )}
    </div>
  );
}
