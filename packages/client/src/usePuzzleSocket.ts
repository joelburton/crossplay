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
  onOpen?: () => void;
};

const RECONNECT_DELAYS_MS = [500, 1000, 2000, 4000, 8000, 16000, 30000];

/**
 * Maintains a single WebSocket connection to a puzzle room, with
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
export function usePuzzleSocket(puzzleId: string, handlers: Handlers) {
  const [state, setState] = useState<ConnState>("connecting");
  const socketRef = useRef<WebSocket | null>(null);
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  useEffect(() => {
    let cancelled = false;
    let attempt = 0;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    function connect() {
      if (cancelled) return;
      setState("connecting");
      const url = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws/puzzles/${puzzleId}`;
      const ws = new WebSocket(url);
      socketRef.current = ws;

      ws.addEventListener("open", () => {
        if (cancelled) return;
        attempt = 0;
        setState("open");
        handlersRef.current.onOpen?.();
      });
      ws.addEventListener("close", () => {
        if (cancelled) return;
        setState("closed");
        const delay = RECONNECT_DELAYS_MS[Math.min(attempt, RECONNECT_DELAYS_MS.length - 1)]!;
        attempt += 1;
        retryTimer = setTimeout(connect, delay);
      });
      ws.addEventListener("error", () => {
        // close handler will fire next; let it own the retry logic
      });
      ws.addEventListener("message", (e) => {
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
  }, [puzzleId]);

  function send(msg: ClientMessage): void {
    const ws = socketRef.current;
    if (ws && ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }

  return { state, send };
}
