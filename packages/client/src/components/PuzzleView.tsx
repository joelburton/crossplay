import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MutableRefObject } from "react";
import type { Cell, ClientMessage, GridSnapshot, PuzzleState } from "@crossplay/shared";
import { MAX_REBUS_LEN, type Direction } from "@crossplay/shared";
import {
  type ArrowKey,
  type Cursor,
  activeClueNumber,
  advanceAfterFill,
  findCellByNumber,
  initialCursor,
  jumpClue,
  moveCursor,
  retreatForBackspace,
  wordCells,
} from "../cursor";
import { type ChatLine, useBoardSocket } from "../useBoardSocket";
import { type ChatIdentity, makeIdentity, persistName, readChatIdentity } from "../chatIdentity";
import type { Feedback } from "../feedback";
import type { PuzzleActions } from "../puzzleActions";
import { Board, NARROW_QUERY } from "./Board";
import { ChatIndicator } from "./ChatIndicator";
import { ChatPanel } from "./ChatPanel";
import { ChatPreview } from "./ChatPreview";
import { ClueList } from "./ClueList";
import { HelpDialog } from "./HelpDialog";
import { NoteDialog } from "./NoteDialog";
import { NumberJumpDialog } from "./NumberJumpDialog";
import { SolvedDialog } from "./SolvedDialog";
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
  collapseRebus: boolean;
  onToggleCollapseRebus: () => void;
  actionsRef?: MutableRefObject<PuzzleActions | null>;
  onActiveClueChange?: (clue: ActiveClue | null) => void;
  onFeedback?: (f: Feedback) => void;
  onActivity?: () => void;
  feedbackVisible?: boolean;
  /** Toggle the App-owned title menu. Wired from a global ⌥M
   *  shortcut so keyboard-only players can reach the menu without a
   *  pointer. */
  onToggleMenu?: () => void;
  /** Called when the user picks "Play a new game" in the celebratory
   *  solved-puzzle dialog. App routes home. */
  onNewGame?: () => void;
  /** Logged-in user's handle, if any. Used as the default chat name
   *  when there's no localStorage override and no `?name=` param. */
  authedHandle?: string | null;
};

/** Outbound cursor-presence throttle window, in ms. Sends fire on the
 *  leading edge (immediate when the throttle is idle) plus a single
 *  trailing edge that carries whatever the latest cursor is. */
const CURSOR_THROTTLE_MS = 80;

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
  // and re-render the whole board for no visible change. Backspace on
  // an already-empty cell falls through here too: that's safe because
  // the server never sets `wrong` on an unfilled cell, so there's no
  // marker we'd be failing to clear.
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

/** Cycle a mark on one edge of a cell through (break → hyphen → none).
 *  Returns the next state; null means clear the mark. Pure; exported
 *  for direct unit testing. */
export function nextMarkState(
  current: "break" | "hyphen" | undefined,
): "break" | "hyphen" | null {
  if (current === undefined) return "break";
  if (current === "break") return "hyphen";
  return null;
}

/** Optimistically apply a mark change locally; cells passed in stays
 *  immutable. Mirrors `setCellFill` for fills. */
function setCellMark(
  cells: Cell[][],
  row: number,
  col: number,
  side: "right" | "bottom",
  type: "break" | "hyphen" | null,
): Cell[][] {
  const cell = cells[row]?.[col];
  if (!cell || cell.kind !== "cell") return cells;
  const key = side === "right" ? "markRight" : "markBottom";
  if ((cell[key] ?? null) === type) return cells;
  const next = cells.slice();
  const nextRow = next[row]!.slice();
  const updated: Cell = { ...cell };
  if (type === null) delete updated[key];
  else updated[key] = type;
  nextRow[col] = updated;
  next[row] = nextRow;
  return next;
}

/**
 * The central play surface. Owns:
 *  - the cursor (row/col + direction);
 *  - the live grid snapshot (mutated by both local typing and server
 *    `cellUpdate` broadcasts; "newer version wins");
 *  - the WebSocket connection (via useBoardSocket);
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
  collapseRebus,
  onToggleCollapseRebus,
  actionsRef,
  onActiveClueChange,
  onFeedback,
  onActivity,
  feedbackVisible,
  onToggleMenu,
  onNewGame,
  authedHandle,
}: Props) {
  const { meta } = puzzle;
  const [snapshot, setSnapshot] = useState<GridSnapshot>(puzzle.snapshot);
  const cells = snapshot.cells;
  // Latest cells, for callbacks that may run with a stale closure
  // (e.g. the rebus commit callback advances the cursor and needs
  // the current grid to decide whether the next cell is open).
  const cellsRef = useRef(cells);
  cellsRef.current = cells;

  const [cursor, setCursor] = useState<Cursor>(
    () => initialCursor(puzzle.snapshot.cells) ?? { row: 0, col: 0, dir: "across" },
  );

  const [identity, setIdentity] = useState<ChatIdentity>(
    () => readChatIdentity(authedHandle),
  );
  const identityRef = useRef(identity);
  identityRef.current = identity;
  const [chatOpen, setChatOpen] = useState(false);
  const [chatMessages, setChatMessages] = useState<ChatLine[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [unreadColor, setUnreadColor] = useState<string | null>(null);
  const [previewLine, setPreviewLine] = useState<ChatLine | null>(null);
  const [notesOpen, setNotesOpen] = useState(false);
  const [rebusOpen, setRebusOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [numberJumpOpen, setNumberJumpOpen] = useState(false);
  const [solvedOpen, setSolvedOpen] = useState(false);
  // SPACE on a multi-char fill shows a read-only zoom-peek of the
  // full string (useful when collapse-rebuses is on, or when the
  // shrunk rebus is hard to read at small cell sizes). Any other
  // handled keystroke dismisses it before acting.
  const [zoomPeek, setZoomPeek] = useState(false);
  const [recentFills, setRecentFills] = useState<Map<string, string>>(new Map());
  const recentTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  // Remote-player cursor positions, keyed by player color. Pure presence:
  // not persisted, not version-stamped, dropped on `cursorLeft`.
  const [remoteCursors, setRemoteCursors] = useState<Map<string, { row: number; col: number; name: string }>>(
    new Map(),
  );
  const chatOpenRef = useRef(chatOpen);
  chatOpenRef.current = chatOpen;
  const helpOpenRef = useRef(helpOpen);
  helpOpenRef.current = helpOpen;
  const numberJumpOpenRef = useRef(numberJumpOpen);
  numberJumpOpenRef.current = numberJumpOpen;
  const solvedOpenRef = useRef(solvedOpen);
  solvedOpenRef.current = solvedOpen;
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
    }, 5000);
    recentTimersRef.current.set(key, timer);
    setRecentFills((prev) => {
      const next = new Map(prev);
      next.set(key, color);
      return next;
    });
  }, []);

  const { state: connState, send } = useBoardSocket(meta.id, {
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
    onCursorMoved: useCallback(
      (row: number, col: number, color: string, name: string) => {
        // Skip our own cursor — we already render the local one. (The
        // server doesn't echo, but be defensive against future fan-out
        // changes.)
        if (color === identityRef.current.color) return;
        setRemoteCursors((prev) => {
          const next = new Map(prev);
          next.set(color, { row, col, name });
          return next;
        });
      },
      [],
    ),
    onPuzzleSolved: useCallback(() => {
      setSolvedOpen(true);
    }, []),
    onCursorLeft: useCallback((color: string) => {
      setRemoteCursors((prev) => {
        if (!prev.has(color)) return prev;
        const next = new Map(prev);
        next.delete(color);
        return next;
      });
    }, []),
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

  // Outbound cursor presence, throttled to ~80ms. Independent of the
  // typing hot path: `send` is non-blocking and these messages never
  // affect local rendering or wait on an ack — so adding this traffic
  // can't make typing feel laggy. See memory `project_optimistic_typing.md`.
  const cursorRef = useRef(cursor);
  cursorRef.current = cursor;
  const lastCursorSentRef = useRef<{ time: number; row: number; col: number }>({
    time: 0,
    row: -1,
    col: -1,
  });
  const cursorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sendCursorNow = useCallback(() => {
    if (cursorTimerRef.current) {
      clearTimeout(cursorTimerRef.current);
      cursorTimerRef.current = null;
    }
    const c = cursorRef.current;
    const id = identityRef.current;
    send({ type: "cursorMoved", row: c.row, col: c.col, color: id.color, name: id.name });
    lastCursorSentRef.current = { time: Date.now(), row: c.row, col: c.col };
  }, [send]);
  useEffect(() => {
    // On disconnect: clear pending timer, reset send history (so the
    // next open triggers an immediate send), and drop remote cursors
    // we won't get fresh updates on until reconnect peers move.
    if (connState !== "open") {
      if (cursorTimerRef.current) {
        clearTimeout(cursorTimerRef.current);
        cursorTimerRef.current = null;
      }
      lastCursorSentRef.current = { time: 0, row: -1, col: -1 };
      // Drop stale peer cursors — we won't get fresh updates until
      // peers move after our reconnect. Return the same reference when
      // already empty to avoid an infinite re-render loop on the initial
      // "connecting" pass (effect fires → setState(new Map()) → effect
      // fires again because the reference changed → ...).
      setRemoteCursors((prev) => (prev.size === 0 ? prev : new Map()));
      return;
    }
    const last = lastCursorSentRef.current;
    if (last.row === cursor.row && last.col === cursor.col) return;
    const elapsed = Date.now() - last.time;
    if (elapsed >= CURSOR_THROTTLE_MS) {
      sendCursorNow();
    } else if (!cursorTimerRef.current) {
      // Trailing send: timer fires after the throttle window with the
      // latest cursorRef value (not necessarily the value that scheduled
      // it — fast successive moves coalesce).
      cursorTimerRef.current = setTimeout(sendCursorNow, CURSOR_THROTTLE_MS - elapsed);
    }
  }, [cursor.row, cursor.col, connState, sendCursorNow]);
  useEffect(() => () => {
    if (cursorTimerRef.current) clearTimeout(cursorTimerRef.current);
  }, []);

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
      setZoomPeek(false);
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
      setZoomPeek(false);
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
        text: "No notes for puzzle",
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
      collapseRebus,
      togglePencil: onToggleMode,
      toggleCollapseRebus: onToggleCollapseRebus,
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
      openRebus: () => setRebusOpen(true),
      showHelp: () => setHelpOpen(true),
      downloadIpuz: () => {
        // Anchor + click is the simplest way to honor the server's
        // Content-Disposition filename without an extra fetch.
        const a = document.createElement("a");
        a.href = `/api/boards/${meta.id}/ipuz`;
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
    collapseRebus,
    meta,
    identity.color,
    onToggleMode,
    onToggleCollapseRebus,
    triggerShowNotes,
  ]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      // Help dialog suppresses board keystrokes; its own Esc handler
      // (capture phase) handles dismissal, and the backdrop swallows
      // clicks. Nothing else should fire while help is open.
      if (helpOpenRef.current) return;
      // Same story for the number-jump popup: it owns its own input.
      if (numberJumpOpenRef.current) return;
      // Solved dialog owns the moment — its own Esc handler closes it,
      // and the Enter on its primary button reaches the focused
      // element via React, not our window listener.
      if (solvedOpenRef.current) return;
      // When the title menu is open, its buttons own keyboard focus
      // and the Menu's own keydown listener handles ArrowUp/Down/
      // Home/End navigation. We must stay out of the way — otherwise
      // arrows move the board cursor in parallel, and (worse) our
      // bare-Enter preventDefault cancels the focused button's native
      // activation so menu items never fire.
      if ((document.activeElement as HTMLElement | null)?.closest('[role="menu"]')) return;

      // Don't intercept anything when an input/textarea has focus
      // (chat input, future search boxes, etc.) — EXCEPT Tab. Tab is
      // reserved for clue navigation everywhere; without this exception
      // a Tab in the chat textarea would move DOM focus out of the
      // panel, and a Tab elsewhere on the page when chat was open used
      // to close the chat (worse: it did so regardless of focus). Let
      // Tab fall through to the clue-navigation branch below; its
      // preventDefault keeps focus where it is.
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) {
        if (e.key !== "Tab") return;
      }

      // "?" opens the help dialog. Shift+/ on US layouts, but we just
      // match the character so it works on layouts where ? lives on a
      // different key.
      if (e.key === "?" && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        setHelpOpen(true);
        return;
      }

      // "#" opens the jump-to-number popup.
      if (e.key === "#" && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        setNumberJumpOpen(true);
        return;
      }

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
        if (e.code === "KeyM") {
          e.preventDefault();
          onToggleMenu?.();
          return;
        }
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      // Spacebar: peek at a multi-char rebus fill in the same overlay
      // box used for editing, but read-only. Does NOT take focus, so
      // any subsequent navigation key still flows through this handler
      // — and we dismiss the peek at the top of every other branch.
      if (e.key === " ") {
        e.preventDefault();
        const { row, col } = cursor;
        const cell = cells[row]?.[col];
        if (cell?.kind === "cell" && cell.fill && cell.fill.length > 1) {
          setZoomPeek(true);
        }
        return;
      }
      // For every other handled key, drop the peek so it doesn't
      // linger over the new cursor position.
      setZoomPeek(false);
      // Shift+Enter opens the rebus overlay over the focused cell. The
      // overlay takes focus immediately, so subsequent keystrokes hit it
      // instead of this handler (the INPUT bail above). Bare Enter is a
      // no-op (used to open rebus but solvers hit it reflexively at the
      // end of a word and the accidental overlay was disruptive).
      if (e.key === "Enter") {
        e.preventDefault();
        if (!e.shiftKey) return;
        const { row, col } = cursor;
        const cell = cells[row]?.[col];
        if (cell?.kind === "cell" && !cell.given) {
          onActivity?.();
          setRebusOpen(true);
        }
        return;
      }
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
        const target = cells[row]?.[col];
        // Given cells are author-prefilled and immutable. Skip the
        // local write + wire send, but still advance — the cursor
        // should slide off a given the way it would slide past an
        // already-correct cell.
        if (target?.kind === "cell" && target.given) {
          setCursor((cur) => advanceAfterFill(cells, cur));
          return;
        }
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
      // Cryptic-style word-break / hyphen marks.
      //   `|` cycles the right-edge mark: none → break → hyphen → none
      //   `_` cycles the bottom-edge mark, same cycle
      // Marks are shared across all collaborators (same model as
      // fills). Open cells only; on a block/null the keystroke is a
      // no-op.
      if (e.key === "|" || e.key === "_") {
        e.preventDefault();
        onActivity?.();
        const { row, col } = cursor;
        const cell = cells[row]?.[col];
        if (!cell || cell.kind !== "cell") return;
        const side = e.key === "|" ? "right" : "bottom";
        const key = side === "right" ? "markRight" : "markBottom";
        const nextType = nextMarkState(cell[key]);
        setSnapshot((prev) => ({
          version: prev.version,
          cells: setCellMark(prev.cells, row, col, side, nextType),
        }));
        send({ type: "mark", row, col, side, markType: nextType });
        return;
      }
      if (e.key === "Backspace") {
        e.preventDefault();
        onActivity?.();
        const { row, col } = cursor;
        const cell = cells[row]?.[col];
        if (cell?.kind === "cell" && cell.given) {
          // Can't erase a given. Mirror the typing-on-given behavior
          // and just retreat the cursor (without clearing the cell we
          // land on, since that cell may itself be a given — we just
          // back off the immovable letter).
          const back = retreatForBackspace(cells, cursor);
          if (back.row !== cursor.row || back.col !== cursor.col) setCursor(back);
          return;
        }
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
    onToggleMenu,
  ]);

  const highlighted = useMemo(() => {
    const set = new Set<string>();
    for (const { row, col } of wordCells(cells, cursor.row, cursor.col, cursor.dir)) {
      set.add(`${row}:${col}`);
    }
    return set;
  }, [cells, cursor]);

  // Flatten the remote-cursor Map to a per-cell color lookup. If two
  // peers share a cell, first-seen wins (rare; not worth visualizing
  // both).
  const remoteCursorByCell = useMemo(() => {
    const map = new Map<string, string>();
    for (const [color, pos] of remoteCursors) {
      const key = `${pos.row}:${pos.col}`;
      if (!map.has(key)) map.set(key, color);
    }
    return map;
  }, [remoteCursors]);

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

  const onRebusCommit = useCallback(
    (raw: string, post: "advance" | "jumpNext" | "jumpPrev") => {
      const value = raw.toUpperCase().replace(/[^A-Z]/g, "").slice(0, MAX_REBUS_LEN);
      const { row, col } = cursor;
      const cell = cells[row]?.[col];
      setRebusOpen(false);
      if (!cell || cell.kind !== "cell") return;
      const isPencil = mode === "pencil";
      // Empty commit clears the cell — same wire shape as a Backspace.
      const letter = value.length === 0 ? null : value;
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
        ...(isPencil && letter ? { pencil: true } : {}),
      });
      // After the commit, move the cursor per the action:
      //   - advance (Enter): one cell forward, stopping at the word end
      //   - jumpNext/Prev (Tab/⇧Tab): jump to the next/previous clue,
      //     just like Tab on a regular cell
      setCursor((cur) => {
        if (post === "advance") return advanceAfterFill(cellsRef.current, cur);
        return jumpClue(cellsRef.current, cur, post === "jumpNext" ? 1 : -1);
      });
    },
    [cells, cursor, mode, send, snapshot.version, identity.color],
  );

  const onRebusCancel = useCallback(() => {
    setRebusOpen(false);
  }, []);

  const rebusInitial = (() => {
    if (!rebusOpen) return "";
    const c = cells[cursor.row]?.[cursor.col];
    return c?.kind === "cell" && c.fill ? c.fill : "";
  })();

  // The peek string follows the cursor cell's fill; if the player
  // moves while the peek is open we'd just dismiss it, so reading
  // straight from the current cursor is fine.
  const zoomPeekValue = (() => {
    if (!zoomPeek) return null;
    const c = cells[cursor.row]?.[cursor.col];
    return c?.kind === "cell" && c.fill && c.fill.length > 1 ? c.fill : null;
  })();

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
          remoteCursorByCell={remoteCursorByCell}
          collapseRebus={collapseRebus}
          onCellClick={onCellClick}
          rebus={
            rebusOpen
              ? {
                  initial: rebusInitial,
                  maxLength: MAX_REBUS_LEN,
                  onCommit: onRebusCommit,
                  onCancel: onRebusCancel,
                }
              : null
          }
          zoom={zoomPeek ? zoomPeekValue : null}
        />
        {/* Narrow-viewport active clue. Shown only when the clue panels
            are hidden (see PuzzleView.module.css); in that mode the
            header slot still shows feedback but its clue fallback is
            hidden via App.module.css, so this panel is the player's
            only way to read the current clue. Two-line clamp keeps
            long cryptic clues legible without reflowing the grid. */}
        <div className={styles.narrowClue}>
          {activeClue ? (
            <>
              <span className={styles.narrowClueLabel}>
                {activeClue.number}
                {activeClue.direction === "across" ? "A" : "D"}
              </span>
              <span className={styles.narrowClueText}>{activeClue.text}</span>
            </>
          ) : null}
        </div>
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
      {helpOpen && <HelpDialog onClose={() => setHelpOpen(false)} />}
      {numberJumpOpen && (
        <NumberJumpDialog
          onSubmit={(n) => {
            const pos = findCellByNumber(cells, n);
            if (!pos) return false;
            setCursor((cur) => ({ ...cur, row: pos.row, col: pos.col }));
            onActivity?.();
            setNumberJumpOpen(false);
            return true;
          }}
          onClose={() => setNumberJumpOpen(false)}
        />
      )}
      {solvedOpen && (
        <SolvedDialog
          onClose={() => setSolvedOpen(false)}
          onNewGame={() => {
            setSolvedOpen(false);
            onNewGame?.();
          }}
        />
      )}
    </div>
  );
}
