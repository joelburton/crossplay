import { useEffect, useRef, useState } from "react";
import type { Cell, ClientMessage, GridSnapshot, ServerMessage } from "@crossplay/shared";
import type { Feedback } from "./feedback";

export type ConnState = "connecting" | "open" | "closed";

export type ChatLine = {
  name: string;
  color: string;
  text: string;
  ts: number;
};

type Handlers = {
  onSnapshot: (snapshot: GridSnapshot) => void;
  onCellUpdate: (
    row: number,
    col: number,
    cell: Cell,
    version: number,
    senderColor: string | undefined,
  ) => void;
  onChatMessage?: (line: ChatLine) => void;
  onNotesShown?: () => void;
  onFeedback?: (feedback: Feedback) => void;
  onCursorMoved?: (row: number, col: number, color: string, name: string) => void;
  onCursorLeft?: (color: string) => void;
  onPuzzleSolved?: () => void;
  onOpen?: () => void;
};

const RECONNECT_DELAYS_MS = [500, 1000, 2000, 4000, 8000, 16000, 30000];

/**
 * Maintains a single WebSocket connection to a board's room, with
 * exponential-backoff auto-reconnect (500ms → 30s cap; resets on each
 * successful open).
 *
 * The latest handler bag is read from a ref on every message, so callers
 * don't have to memoize `handlers` — pass fresh closures every render.
 *
 * Returns:
 *   - `state`: "connecting" | "open" | "closed".
 *   - `send(msg)`: serializes and writes a ClientMessage if the socket
 *     is OPEN; otherwise silently drops. (Optimistic UI is the caller's
 *     responsibility — see CLAUDE.md "Optimistic typing".)
 *
 * Caveat: a fresh `snapshot` arrives on every reconnect and replaces local
 * state. Fills typed during a disconnect are not buffered or replayed —
 * see code-review-1.md §1.3.
 */
export function useBoardSocket(boardId: string, handlers: Handlers) {
  const [state, setState] = useState<ConnState>("connecting");
  const socketRef = useRef<WebSocket | null>(null);
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  useEffect(() => {
    let cancelled = false;
    let attempt = 0;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    // Diagnostic timestamps logged on close so we can tell an
    // idle-timeout kill from a peer/server close. Reset on each
    // connect() so they describe the most recent socket only.
    let openedAt = 0;
    let lastMessageAt = 0;

    function connect() {
      if (cancelled) return;
      setState("connecting");
      const url = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws/boards/${boardId}`;
      const ws = new WebSocket(url);
      socketRef.current = ws;

      ws.addEventListener("open", () => {
        if (cancelled) return;
        attempt = 0;
        openedAt = Date.now();
        lastMessageAt = openedAt;
        setState("open");
        console.info("[ws] open", { url, boardId });
        handlersRef.current.onOpen?.();
      });
      ws.addEventListener("close", (ev) => {
        if (cancelled) return;
        setState("closed");
        const now = Date.now();
        // wasClean + standard close codes help triage: 1000 normal,
        // 1001 going-away (tab close / refresh), 1006 abnormal
        // (network drop / server terminate), 1008 policy (e.g. our
        // "board not found"). If `code === 1006` and the socket was
        // idle for > the server's heartbeat window, suspect a
        // missed-pong termination.
        console.warn("[ws] close", {
          boardId,
          code: ev.code,
          reason: ev.reason,
          wasClean: ev.wasClean,
          msSinceOpen: openedAt ? now - openedAt : null,
          msSinceLastMessage: lastMessageAt ? now - lastMessageAt : null,
          attempt,
        });
        const delay = RECONNECT_DELAYS_MS[Math.min(attempt, RECONNECT_DELAYS_MS.length - 1)]!;
        attempt += 1;
        retryTimer = setTimeout(connect, delay);
      });
      ws.addEventListener("error", () => {
        // close handler will fire next; let it own the retry logic.
        // The Event object on ws errors carries no useful info, so we
        // just log the fact — close will follow with the real code.
        console.warn("[ws] error (close follows)", { boardId });
      });
      ws.addEventListener("message", (e) => {
        lastMessageAt = Date.now();
        let msg: ServerMessage;
        try {
          msg = JSON.parse(typeof e.data === "string" ? e.data : "");
        } catch {
          return;
        }
        if (msg.type === "snapshot") handlersRef.current.onSnapshot(msg.snapshot);
        else if (msg.type === "cellUpdate") {
          handlersRef.current.onCellUpdate(
            msg.row,
            msg.col,
            msg.cell,
            msg.version,
            msg.senderColor,
          );
        } else if (msg.type === "chatMessage") {
          handlersRef.current.onChatMessage?.({
            name: msg.name,
            color: msg.color,
            text: msg.text,
            ts: msg.ts,
          });
        } else if (msg.type === "notesShown") {
          handlersRef.current.onNotesShown?.();
        } else if (msg.type === "feedback") {
          handlersRef.current.onFeedback?.({
            id: msg.id,
            text: msg.text,
            level: msg.level,
            autoVanishMs: msg.autoVanishMs,
          });
        } else if (msg.type === "cursorMoved") {
          handlersRef.current.onCursorMoved?.(msg.row, msg.col, msg.color, msg.name);
        } else if (msg.type === "cursorLeft") {
          handlersRef.current.onCursorLeft?.(msg.color);
        } else if (msg.type === "puzzleSolved") {
          handlersRef.current.onPuzzleSolved?.();
        }
      });
    }

    connect();

    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
      socketRef.current?.close();
      socketRef.current = null;
    };
  }, [boardId]);

  function send(msg: ClientMessage): void {
    const ws = socketRef.current;
    if (ws && ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }

  return { state, send };
}
