import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import type {
  Cell,
  ClientMessage,
  Direction,
  Scope,
  ServerMessage,
} from "@crossplay/shared";
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

function isScope(v: unknown): v is Scope {
  return v === "letter" || v === "word" || v === "puzzle";
}

function isDirection(v: unknown): v is Direction {
  return v === "across" || v === "down";
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

  if (m.type === "fill") {
    if (
      typeof m.row !== "number" ||
      typeof m.col !== "number" ||
      typeof m.clientVersion !== "number"
    ) return null;
    if (m.letter !== null && typeof m.letter !== "string") return null;
    const senderColor = isHexColor(m.senderColor) ? m.senderColor : undefined;
    return {
      type: "fill",
      row: m.row,
      col: m.col,
      letter: m.letter,
      clientVersion: m.clientVersion,
      ...(senderColor ? { senderColor } : {}),
    };
  }

  if (m.type === "clear") return { type: "clear" };

  if (m.type === "showNotes") return { type: "showNotes" };

  if (m.type === "chat") {
    if (
      typeof m.name !== "string" ||
      typeof m.color !== "string" ||
      typeof m.text !== "string"
    ) return null;
    const text = m.text.trim();
    if (!text) return null;
    if (text.length > 500) return null;
    if (m.name.length === 0 || m.name.length > 32) return null;
    if (!/^#[0-9a-f]{6}$/i.test(m.color)) return null;
    return { type: "chat", name: m.name, color: m.color, text };
  }

  if (m.type === "reveal" || m.type === "check") {
    if (!isScope(m.scope)) return null;
    if (m.scope !== "puzzle") {
      if (typeof m.row !== "number" || typeof m.col !== "number") return null;
      if (m.scope === "word" && !isDirection(m.dir)) return null;
    }
    const senderColor = m.type === "reveal" && isHexColor(m.senderColor)
      ? m.senderColor
      : undefined;
    return {
      type: m.type,
      scope: m.scope,
      ...(typeof m.row === "number" ? { row: m.row } : {}),
      ...(typeof m.col === "number" ? { col: m.col } : {}),
      ...(isDirection(m.dir) ? { dir: m.dir } : {}),
      ...(senderColor ? { senderColor } : {}),
    } as ClientMessage;
  }

  return null;
}

function isHexColor(v: unknown): v is string {
  return typeof v === "string" && /^#[0-9a-f]{6}$/i.test(v);
}

type CellChange = { row: number; col: number; cell: Cell; senderColor?: string };

function isOpen(entry: StoredPuzzle, r: number, c: number): boolean {
  const { meta, snapshot } = entry.state;
  if (r < 0 || c < 0 || r >= meta.height || c >= meta.width) return false;
  return snapshot.cells[r]![c]!.kind === "cell";
}

function findWordStart(
  entry: StoredPuzzle,
  row: number,
  col: number,
  dir: Direction,
): { row: number; col: number } {
  const dr = dir === "down" ? -1 : 0;
  const dc = dir === "across" ? -1 : 0;
  let r = row;
  let c = col;
  while (isOpen(entry, r + dr, c + dc)) {
    r += dr;
    c += dc;
  }
  return { row: r, col: c };
}

function wordCells(
  entry: StoredPuzzle,
  row: number,
  col: number,
  dir: Direction,
): { row: number; col: number }[] {
  if (!isOpen(entry, row, col)) return [];
  const start = findWordStart(entry, row, col, dir);
  const dr = dir === "down" ? 1 : 0;
  const dc = dir === "across" ? 1 : 0;
  const out: { row: number; col: number }[] = [];
  let r = start.row;
  let c = start.col;
  while (isOpen(entry, r, c)) {
    out.push({ row: r, col: c });
    r += dr;
    c += dc;
  }
  return out;
}

export function applyFill(
  entry: StoredPuzzle,
  msg: Extract<ClientMessage, { type: "fill" }>,
): CellChange | null {
  const { meta, snapshot } = entry.state;
  if (msg.row < 0 || msg.row >= meta.height) return null;
  if (msg.col < 0 || msg.col >= meta.width) return null;
  const cell = snapshot.cells[msg.row]![msg.col]!;
  if (cell.kind !== "cell") return null;
  if (msg.letter !== null && msg.letter.length !== 1) return null;
  const letter = msg.letter == null ? null : msg.letter.toUpperCase();
  if (letter !== null && !/^[A-Z]$/.test(letter)) return null;
  cell.fill = letter;
  delete cell.wrong;
  snapshot.version += 1;
  return {
    row: msg.row,
    col: msg.col,
    cell,
    ...(msg.senderColor ? { senderColor: msg.senderColor } : {}),
  };
}

function revealAt(entry: StoredPuzzle, row: number, col: number): CellChange | null {
  const cell = entry.state.snapshot.cells[row]?.[col];
  if (!cell || cell.kind !== "cell") return null;
  const sol = entry.solution[row]?.[col];
  if (sol == null) return null;
  cell.fill = sol;
  cell.revealed = true;
  delete cell.wrong;
  return { row, col, cell };
}

function checkAt(entry: StoredPuzzle, row: number, col: number): CellChange | null {
  const cell = entry.state.snapshot.cells[row]?.[col];
  if (!cell || cell.kind !== "cell") return null;
  if (cell.fill == null) return null; // skip empty cells
  const sol = entry.solution[row]?.[col];
  const wasWrong = cell.wrong === true;
  if (cell.fill !== sol) {
    if (wasWrong) return null; // already marked, no change
    cell.wrong = true;
    return { row, col, cell };
  }
  if (wasWrong) {
    delete cell.wrong;
    return { row, col, cell };
  }
  return null;
}

function targetCells(
  entry: StoredPuzzle,
  msg: Extract<ClientMessage, { type: "reveal" | "check" }>,
): { row: number; col: number }[] {
  const { meta } = entry.state;
  if (msg.scope === "puzzle") {
    const out: { row: number; col: number }[] = [];
    for (let r = 0; r < meta.height; r++) {
      for (let c = 0; c < meta.width; c++) {
        if (isOpen(entry, r, c)) out.push({ row: r, col: c });
      }
    }
    return out;
  }
  if (typeof msg.row !== "number" || typeof msg.col !== "number") return [];
  if (msg.scope === "letter") return [{ row: msg.row, col: msg.col }];
  // word
  if (!msg.dir) return [];
  return wordCells(entry, msg.row, msg.col, msg.dir);
}

export function applyReveal(
  entry: StoredPuzzle,
  msg: Extract<ClientMessage, { type: "reveal" }>,
): CellChange[] {
  const changes: CellChange[] = [];
  for (const { row, col } of targetCells(entry, msg)) {
    const change = revealAt(entry, row, col);
    if (change) {
      entry.state.snapshot.version += 1;
      if (msg.senderColor) change.senderColor = msg.senderColor;
      changes.push(change);
    }
  }
  return changes;
}

export function applyClear(entry: StoredPuzzle): CellChange[] {
  const changes: CellChange[] = [];
  const { meta, snapshot } = entry.state;
  for (let r = 0; r < meta.height; r++) {
    for (let c = 0; c < meta.width; c++) {
      const cell = snapshot.cells[r]![c]!;
      if (cell.kind !== "cell") continue;
      if (cell.fill == null && !cell.wrong && !cell.revealed) continue;
      cell.fill = null;
      delete cell.wrong;
      delete cell.revealed;
      snapshot.version += 1;
      changes.push({ row: r, col: c, cell });
    }
  }
  return changes;
}

export function applyCheck(
  entry: StoredPuzzle,
  msg: Extract<ClientMessage, { type: "check" }>,
): CellChange[] {
  const changes: CellChange[] = [];
  for (const { row, col } of targetCells(entry, msg)) {
    const change = checkAt(entry, row, col);
    if (change) {
      entry.state.snapshot.version += 1;
      changes.push(change);
    }
  }
  return changes;
}

function broadcastChanges(entry: StoredPuzzle, changes: CellChange[]): void {
  if (changes.length === 0) return;
  // Reconstruct per-change versions: each change bumped the version once,
  // so the i-th change's version is (final - changes.length + 1 + i).
  const final = entry.state.snapshot.version;
  for (let i = 0; i < changes.length; i++) {
    const { row, col, cell, senderColor } = changes[i]!;
    const version = final - changes.length + 1 + i;
    broadcast(entry, {
      type: "cellUpdate",
      row,
      col,
      cell,
      version,
      ...(senderColor ? { senderColor } : {}),
    });
  }
}

const HEARTBEAT_INTERVAL_MS = 15_000;

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

      // Heartbeat: server pings every interval; browser auto-pongs.
      // If the previous ping was never answered, terminate the socket.
      let isAlive = true;
      socket.on("pong", () => {
        isAlive = true;
      });
      const heartbeat = setInterval(() => {
        if (!isAlive) {
          socket.terminate();
          return;
        }
        isAlive = false;
        try {
          socket.ping();
        } catch {
          socket.terminate();
        }
      }, HEARTBEAT_INTERVAL_MS);

      socket.on("message", (raw) => {
        const msg = parseMessage(raw);
        if (!msg) return;
        if (msg.type === "fill") {
          const change = applyFill(entry, msg);
          if (change) broadcastChanges(entry, [change]);
          return;
        }
        if (msg.type === "reveal") {
          broadcastChanges(entry, applyReveal(entry, msg));
          return;
        }
        if (msg.type === "check") {
          broadcastChanges(entry, applyCheck(entry, msg));
          return;
        }
        if (msg.type === "clear") {
          broadcastChanges(entry, applyClear(entry));
          return;
        }
        if (msg.type === "chat") {
          broadcast(entry, {
            type: "chatMessage",
            name: msg.name,
            color: msg.color,
            text: msg.text,
            ts: Date.now(),
          });
          return;
        }
        if (msg.type === "showNotes") {
          broadcast(entry, { type: "notesShown" });
          return;
        }
      });

      socket.on("close", () => {
        clearInterval(heartbeat);
        entry.sockets.delete(socket);
      });
    },
  );
}
