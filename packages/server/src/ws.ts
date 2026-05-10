import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import type { ClientMessage, ServerMessage } from "@crossplay/shared";
import { getPuzzle, type StoredPuzzle } from "./store.js";

function send(socket: WebSocket, msg: ServerMessage): void {
  if (socket.readyState === socket.OPEN) {
    socket.send(JSON.stringify(msg));
  }
}

function broadcast(entry: StoredPuzzle, msg: ServerMessage): void {
  const payload = JSON.stringify(msg);
  for (const s of entry.sockets) {
    if (s.readyState === s.OPEN) s.send(payload);
  }
}

export function parseMessage(raw: unknown): ClientMessage | null {
  if (typeof raw !== "string" && !(raw instanceof Buffer)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString());
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const m = parsed as Record<string, unknown>;
  if (m.type !== "fill") return null;
  if (
    typeof m.row !== "number" ||
    typeof m.col !== "number" ||
    typeof m.clientVersion !== "number"
  ) return null;
  if (m.letter !== null && typeof m.letter !== "string") return null;
  return {
    type: "fill",
    row: m.row,
    col: m.col,
    letter: m.letter,
    clientVersion: m.clientVersion,
  };
}

export function applyFill(
  entry: StoredPuzzle,
  msg: Extract<ClientMessage, { type: "fill" }>,
): { row: number; col: number; letter: string | null; version: number } | null {
  const { meta, snapshot } = entry.state;
  if (msg.row < 0 || msg.row >= meta.height) return null;
  if (msg.col < 0 || msg.col >= meta.width) return null;
  const cell = snapshot.cells[msg.row]![msg.col]!;
  if (cell.kind !== "cell") return null;
  if (msg.letter !== null && msg.letter.length !== 1) return null;
  const letter = msg.letter == null ? null : msg.letter.toUpperCase();
  if (letter !== null && !/^[A-Z]$/.test(letter)) return null;
  cell.fill = letter;
  snapshot.version += 1;
  return { row: msg.row, col: msg.col, letter, version: snapshot.version };
}

export function registerWsRoutes(app: FastifyInstance): void {
  app.get<{ Params: { id: string } }>(
    "/puzzles/:id/ws",
    { websocket: true },
    (socket, req) => {
      const id = req.params.id;
      const entry = getPuzzle(id);
      if (!entry) {
        socket.close(1008, "puzzle not found");
        return;
      }

      entry.sockets.add(socket);
      send(socket, { type: "snapshot", snapshot: entry.state.snapshot });

      socket.on("message", (raw) => {
        const msg = parseMessage(raw);
        if (!msg) return;
        const update = applyFill(entry, msg);
        if (!update) return;
        broadcast(entry, { type: "cellUpdate", ...update });
      });

      socket.on("close", () => {
        entry.sockets.delete(socket);
      });
    },
  );
}
