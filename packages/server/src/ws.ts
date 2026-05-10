/**
 * Authoritative server‑side game logic.
 *
 * Every grid mutation flows through this module: clients send a
 * `ClientMessage`, `parseMessage` validates it, an `apply*` helper
 * mutates the stored snapshot, and the result is broadcast as
 * `cellUpdate` (and possibly `feedback`) to the room.
 *
 * The `apply*` helpers are pure(‑ish): they take a `StoredBoard` and a
 * message, mutate the snapshot, and return the change list. They're
 * exported so unit tests can drive them without spinning up Fastify.
 *
 * The Fastify route at the bottom (`registerWsRoutes`) is the only thing
 * that actually owns the WebSocket — it dispatches to `apply*` and
 * handles heartbeats, hello debouncing, and chat broadcast.
 */

import type { FastifyInstance } from "fastify";
import type { DatabaseSync } from "node:sqlite";
import type { WebSocket } from "ws";
import type {
  Cell,
  ClientMessage,
  Direction,
  Scope,
  ServerMessage,
} from "@crossplay/shared";
import { MAX_REBUS_LEN } from "./ipuz.js";
import { flushAndEvict, getOrLoadBoard, markDirty, type StoredBoard } from "./store.js";

/** Send a message on a single socket if it's still OPEN; no‑op otherwise. */
function send(socket: WebSocket, msg: ServerMessage): void {
  if (socket.readyState === socket.OPEN) {
    socket.send(JSON.stringify(msg));
  }
}

/** Broadcast a message to every OPEN socket in the room. Serializes once. */
function broadcast(entry: StoredBoard, msg: ServerMessage): void {
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

/**
 * Validate and normalize an inbound client message.
 *
 * Returns a typed `ClientMessage` on success, `null` on any kind of
 * failure (non‑string, malformed JSON, unknown type, missing fields,
 * out‑of‑range values). Optional fields like `senderColor` are silently
 * dropped if invalid rather than rejecting the whole message — that lets
 * future clients add fields without breaking older servers.
 *
 * Pure; exported so unit tests can drive every branch without a socket.
 */
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
    const pencil = m.pencil === true;
    return {
      type: "fill",
      row: m.row,
      col: m.col,
      letter: m.letter,
      clientVersion: m.clientVersion,
      ...(senderColor ? { senderColor } : {}),
      ...(pencil ? { pencil: true } : {}),
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
    const name = sanitizeName(m.name);
    if (name.length === 0 || name.length > 32) return null;
    if (!/^#[0-9a-f]{6}$/i.test(m.color)) return null;
    return { type: "chat", name, color: m.color, text };
  }

  if (m.type === "hello") {
    if (typeof m.name !== "string" || typeof m.color !== "string") return null;
    const name = sanitizeName(m.name);
    if (name.length === 0 || name.length > 32 || !isHexColor(m.color)) return null;
    return { type: "hello", name, color: m.color };
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

/** Strict #rrggbb (lowercase or uppercase) check. Used to validate the
 *  optional `senderColor` and the chat `color`. */
function isHexColor(v: unknown): v is string {
  return typeof v === "string" && /^#[0-9a-f]{6}$/i.test(v);
}

/**
 * Normalize a player name before length validation: strip C0/DEL
 * control characters (so "alice\n[admin]" can't masquerade as two
 * lines in the chat list), collapse internal whitespace runs to a
 * single space, and trim. Pure; exported for direct unit testing.
 *
 * The output is the canonical form we both validate and broadcast,
 * so two clients sending visually equivalent names always see the
 * same string.
 */
export function sanitizeName(name: string): string {
  // \u0000-\u001f covers the C0 control range; \u007f is DEL. Written as
  // \u escapes (rather than literal bytes) so the source stays plain ASCII.
  return name
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

type CellChange = { row: number; col: number; cell: Cell; senderColor?: string };

// Accepted fill: 1–MAX_REBUS_LEN uppercase letters. Rebus answers
// flow through the same `fill` message as single letters (`letter`
// just gets longer), so this regex gates both paths.
const FILL_RE = new RegExp(`^[A-Z]{1,${MAX_REBUS_LEN}}$`);

/** True iff `(r, c)` is inside the grid and is a fillable (non‑block) cell. */
function isOpen(entry: StoredBoard, r: number, c: number): boolean {
  const { meta, snapshot } = entry.state;
  if (r < 0 || c < 0 || r >= meta.height || c >= meta.width) return false;
  return snapshot.cells[r]![c]!.kind === "cell";
}

/** Walk back to the start of the word that contains `(row, col)` in the
 *  given direction. Returns the input cell unchanged if it is itself a
 *  block (callers should guard with `isOpen` first). */
function findWordStart(
  entry: StoredBoard,
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

/** Every cell in the word containing `(row, col)` in `dir`, in word order
 *  from start to end. Empty array if `(row, col)` is a block. */
function wordCells(
  entry: StoredBoard,
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

/**
 * Apply a single‑cell fill (letter or erase).
 *
 * Validates bounds, cell kind, and letter shape (single A–Z after
 * uppercasing). On a successful fill, clears any prior `wrong` flag
 * (the user is editing, so the server should re‑check on the next
 * `check`), preserves `revealed` (it stays true even if the user types
 * a different letter), and toggles `pencil` based on `msg.pencil`.
 *
 * Bumps `snapshot.version` exactly once per accepted change. Returns
 * `null` if the message is invalid (no broadcast happens in that case).
 */
export function applyFill(
  entry: StoredBoard,
  msg: Extract<ClientMessage, { type: "fill" }>,
): CellChange | null {
  const { meta, snapshot } = entry.state;
  if (msg.row < 0 || msg.row >= meta.height) return null;
  if (msg.col < 0 || msg.col >= meta.width) return null;
  const cell = snapshot.cells[msg.row]![msg.col]!;
  if (cell.kind !== "cell") return null;
  const letter = msg.letter == null ? null : msg.letter.toUpperCase();
  if (letter !== null && !FILL_RE.test(letter)) return null;
  cell.fill = letter;
  delete cell.wrong;
  if (letter === null || !msg.pencil) {
    delete cell.pencil;
  } else {
    cell.pencil = true;
  }
  snapshot.version += 1;
  return {
    row: msg.row,
    col: msg.col,
    cell,
    ...(msg.senderColor ? { senderColor: msg.senderColor } : {}),
  };
}

/** Reveal the solution letter at one cell. Sets `revealed: true`, clears
 *  `wrong` and `pencil`. Returns `null` if the cell is a block, has no
 *  solution, or is already in the post-reveal state (consistent with
 *  `applyCheck` / `applyClear`: don't re-broadcast no-ops). */
function revealAt(entry: StoredBoard, row: number, col: number): CellChange | null {
  const cell = entry.state.snapshot.cells[row]?.[col];
  if (!cell || cell.kind !== "cell") return null;
  const sol = entry.solution[row]?.[col];
  if (sol == null) return null;
  if (cell.revealed && cell.fill === sol && !cell.wrong && !cell.pencil) return null;
  cell.fill = sol;
  cell.revealed = true;
  delete cell.wrong;
  delete cell.pencil;
  return { row, col, cell };
}

/**
 * Check one cell against the solution.
 *
 * Returns a change only when the visible state needs to update:
 *   - newly wrong → set `wrong: true`;
 *   - was wrong, now right → clear the `wrong` flag.
 * Empty cells and pencil cells are skipped (no change emitted).
 * Already‑wrong cells that are still wrong return `null` (no spurious
 * re‑broadcast).
 */
function checkAt(entry: StoredBoard, row: number, col: number): CellChange | null {
  const cell = entry.state.snapshot.cells[row]?.[col];
  if (!cell || cell.kind !== "cell") return null;
  if (cell.fill == null) return null; // skip empty cells
  if (cell.pencil) return null; // skip pencil cells
  const sol = entry.solution[row]?.[col];
  const wasWrong = cell.wrong === true;
  if (!fillMatchesSolution(cell.fill, sol)) {
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

/** True if `fill` is an acceptable answer for `sol`. Single-letter
 *  solutions require an exact match. For rebus solutions (length > 1)
 *  we also accept the first letter alone — it's a long-standing NYT
 *  convention and saves players from having to type out the full
 *  rebus on small screens. The fill stays whatever the player typed;
 *  only the check decision is affected. */
export function fillMatchesSolution(fill: string, sol: string | null | undefined): boolean {
  if (sol == null) return false;
  if (fill === sol) return true;
  if (sol.length > 1 && fill === sol[0]) return true;
  return false;
}

/** Resolve the set of cells a reveal/check message applies to:
 *  letter → just `(row, col)`; word → the across/down word containing it;
 *  puzzle → every open cell in the grid. */
function targetCells(
  entry: StoredBoard,
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

/**
 * Apply a reveal at letter / word / puzzle scope.
 *
 * Bumps `snapshot.version` once per cell that actually changed (so each
 * resulting `cellUpdate` carries a distinct version, see
 * `broadcastChanges`). Carries `senderColor` through so other clients
 * can briefly flash the revealing player's color on the cell.
 */
export function applyReveal(
  entry: StoredBoard,
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

/**
 * Restore the grid to its initial (creation-time) state. Cells whose
 * current state matches the initial are skipped (no spurious broadcast);
 * the rest have their fields mutated in place to match the initial,
 * bumping `snapshot.version` once apiece.
 *
 * Restoring (rather than wiping) means author-prefilled cells survive
 * a clear — clearing your own typing doesn't erase the puzzle's givens.
 *
 * In-place mutation preserves cell object identity, matching how
 * `applyFill` mutates cells; this is what callers and tests expect.
 */
export function applyClear(entry: StoredBoard): CellChange[] {
  const changes: CellChange[] = [];
  const { meta, snapshot } = entry.state;
  const initial = entry.initialSnapshot;
  for (let r = 0; r < meta.height; r++) {
    for (let c = 0; c < meta.width; c++) {
      const live = snapshot.cells[r]![c]!;
      const init = initial.cells[r]![c]!;
      if (cellsEqual(live, init)) continue;
      // Both kinds match in practice (puzzle structure is fixed), so
      // we can mutate in place. If they ever diverge, fall back to a
      // deep-clone replace to keep the slot consistent.
      if (live.kind === "cell" && init.kind === "cell") {
        live.number = init.number;
        live.fill = init.fill;
        if (init.revealed) live.revealed = true;
        else delete live.revealed;
        if (init.wrong) live.wrong = true;
        else delete live.wrong;
        if (init.pencil) live.pencil = true;
        else delete live.pencil;
        snapshot.version += 1;
        changes.push({ row: r, col: c, cell: live });
      } else {
        const restored = JSON.parse(JSON.stringify(init)) as Cell;
        snapshot.cells[r]![c] = restored;
        snapshot.version += 1;
        changes.push({ row: r, col: c, cell: restored });
      }
    }
  }
  return changes;
}

/** Structural equality for two Cells. Compares kind + every visible
 *  field; treats missing optional flags as equal to absent (so `{}` and
 *  `{ pencil: undefined }` look the same). */
function cellsEqual(a: Cell, b: Cell): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "block") return true;
  // both are cells
  const bb = b as Extract<Cell, { kind: "cell" }>;
  return (
    a.number === bb.number &&
    a.fill === bb.fill &&
    !!a.revealed === !!bb.revealed &&
    !!a.wrong === !!bb.wrong &&
    !!a.pencil === !!bb.pencil
  );
}

/**
 * Apply a check at letter / word / puzzle scope.
 *
 * Pencil cells are skipped at the per‑cell level (`checkAt` returns
 * `null` for them); the route handler separately broadcasts a "Check
 * skips pencil cells" feedback when at least one such cell was in
 * scope (see `checkScopeHasPencil` and the `case "check"` block in
 * `registerWsRoutes`).
 */
export function applyCheck(
  entry: StoredBoard,
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

// Counter feeding the `id` field on broadcast `feedback` messages.
// IDs need only be unique enough that React's reconciler treats two
// successive feedback events as distinct keys. We seed with the current
// `Date.now()` (base‑36) and append a per‑room monotonic counter; the
// `>>> 0` keeps the counter in 32‑bit unsigned territory so the base‑36
// string stays short. Per‑puzzle so two rooms' feedback streams stay
// independent and log lines are easier to attribute.
function nextFeedbackId(entry: StoredBoard): string {
  entry.feedbackCounter = (entry.feedbackCounter + 1) >>> 0;
  return `f${Date.now().toString(36)}_${entry.feedbackCounter.toString(36)}`;
}

/** True if any cell in the requested check scope is currently a pencil
 *  fill. Used to decide whether to broadcast the "check skips pencil
 *  cells" warning feedback. Exported for direct unit testing. */
export function checkScopeHasPencil(
  entry: StoredBoard,
  msg: Extract<ClientMessage, { type: "check" }>,
): boolean {
  for (const { row, col } of targetCells(entry, msg)) {
    const c = entry.state.snapshot.cells[row]?.[col];
    if (c?.kind === "cell" && c.fill && c.pencil) return true;
  }
  return false;
}

const HELLO_DEBOUNCE_MS = 30_000;

// How long an entry can sit in `recentHellos` before being pruned.
// 4× the debounce window means a returning player still gets the silent
// reconnect within the debounce, but a one-off visitor's name is gone
// well before the map can grow without bound.
const HELLO_PRUNE_AFTER_MS = HELLO_DEBOUNCE_MS * 4;

/**
 * Decide whether to broadcast an "Alice joined" feedback for a given hello.
 * A hello is announced if there's no prior record for the name, or if the
 * last hello for that name is older than `debounceMs`. Pure; exported for
 * direct unit testing.
 */
export function shouldAnnounceHello(
  last: number | undefined,
  now: number,
  debounceMs: number,
): boolean {
  return last == null || now - last > debounceMs;
}

/**
 * Drop entries from a `recentHellos` map whose timestamps are older than
 * `now - maxAgeMs`. Mutates the map in place. Pure (apart from that
 * mutation); exported for direct unit testing.
 *
 * Called opportunistically on each hello, so the cost is amortized
 * across normal traffic and we never need a periodic timer.
 */
export function pruneRecentHellos(
  recentHellos: Map<string, number>,
  now: number,
  maxAgeMs: number,
): void {
  const cutoff = now - maxAgeMs;
  for (const [name, ts] of recentHellos) {
    if (ts < cutoff) recentHellos.delete(name);
  }
}

/**
 * Broadcast a batch of cell changes as individual `cellUpdate` messages,
 * each carrying its own snapshot version.
 *
 * Each change bumped `snapshot.version` once when applied, so we can
 * reconstruct per‑change versions by walking backwards from the final
 * version. Worked example: 3 changes ending at version 7 → versions
 * 5, 6, 7 (i = 0, 1, 2 with `final - len + 1 + i` = 5, 6, 7).
 *
 * One‑message‑per‑change is intentional: the client's "newer version
 * wins" check (`if (version <= prev.version) return prev`) then applies
 * every update from a batch, in order.
 */
function broadcastChanges(entry: StoredBoard, changes: CellChange[]): void {
  if (changes.length === 0) return;
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

export type WsRouteOptions = {
  /** Required: sqlite handle. Boards are loaded lazily from this on
   *  first connect to a given id. */
  db: DatabaseSync;
  // Override the per-connection ping cadence. The integration test lowers
  // this to drive the silent-disconnect path in milliseconds rather than
  // the production 15s.
  heartbeatIntervalMs?: number;
};

/**
 * Register the `/ws/boards/:id` WebSocket route.
 *
 * Per connection:
 *   - On open: lazy-load the board into the in-memory cache, add to the
 *     room, send a `snapshot`, start a heartbeat.
 *   - On message: validate via `parseMessage`, dispatch to the matching
 *     `apply*` helper or chat/notes/hello side effect, broadcast,
 *     mark the board dirty if play state changed.
 *   - On close: clear the heartbeat, remove from the room set, and
 *     `flushAndEvict` if this was the last socket on the room.
 *
 * The heartbeat pings every `HEARTBEAT_INTERVAL_MS` and terminates the
 * socket if no `pong` came back since the previous tick — so silent
 * disconnects (broken NAT, sleeping laptop) clear within ~30s.
 */
export function registerWsRoutes(
  app: FastifyInstance,
  opts: WsRouteOptions,
): void {
  const { db } = opts;
  const heartbeatIntervalMs = opts.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS;
  app.get<{ Params: { id: string } }>(
    "/ws/boards/:id",
    { websocket: true },
    (socket, req) => {
      const id = req.params.id;
      const entry = getOrLoadBoard(db, id);
      if (!entry) {
        socket.close(1008, "board not found");
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
      }, heartbeatIntervalMs);

      socket.on("message", (raw) => {
        const msg = parseMessage(raw);
        if (!msg) return;
        if (msg.type === "fill") {
          const change = applyFill(entry, msg);
          if (change) {
            broadcastChanges(entry, [change]);
            markDirty(db, entry.id);
          }
          return;
        }
        if (msg.type === "reveal") {
          const changes = applyReveal(entry, msg);
          broadcastChanges(entry, changes);
          if (changes.length > 0) markDirty(db, entry.id);
          return;
        }
        if (msg.type === "check") {
          const hadPencil = checkScopeHasPencil(entry, msg);
          const changes = applyCheck(entry, msg);
          broadcastChanges(entry, changes);
          if (changes.length > 0) markDirty(db, entry.id);
          if (hadPencil) {
            broadcast(entry, {
              type: "feedback",
              id: nextFeedbackId(entry),
              text: "Check skips pencil cells",
              level: "warning",
              autoVanishMs: 5000,
            });
          }
          return;
        }
        if (msg.type === "clear") {
          const changes = applyClear(entry);
          broadcastChanges(entry, changes);
          if (changes.length > 0) markDirty(db, entry.id);
          return;
        }
        if (msg.type === "chat") {
          const ts = Date.now();
          entry.chat.push({ name: msg.name, color: msg.color, text: msg.text, ts });
          markDirty(db, entry.id);
          broadcast(entry, {
            type: "chatMessage",
            name: msg.name,
            color: msg.color,
            text: msg.text,
            ts,
          });
          return;
        }
        if (msg.type === "showNotes") {
          broadcast(entry, { type: "notesShown" });
          return;
        }
        if (msg.type === "hello") {
          const now = Date.now();
          // Opportunistic GC: keeps the map bounded for long-lived rooms
          // with high name churn (`Rando<NN>` defaults, etc.).
          pruneRecentHellos(entry.recentHellos, now, HELLO_PRUNE_AFTER_MS);
          const last = entry.recentHellos.get(msg.name);
          entry.recentHellos.set(msg.name, now);
          if (shouldAnnounceHello(last, now, HELLO_DEBOUNCE_MS)) {
            // Broadcast to others only — sender doesn't see their own join.
            const payload = JSON.stringify({
              type: "feedback",
              id: nextFeedbackId(entry),
              text: `${msg.name} joined the game`,
              level: "info",
              autoVanishMs: 5000,
            });
            for (const s of entry.sockets) {
              if (s !== socket && s.readyState === s.OPEN) s.send(payload);
            }
          }
          return;
        }
      });

      socket.on("close", () => {
        clearInterval(heartbeat);
        entry.sockets.delete(socket);
        // Last connection out: persist + drop the cache entry. A
        // future reconnect will lazy-load it again.
        if (entry.sockets.size === 0) {
          flushAndEvict(db, entry.id);
        }
      });
    },
  );
}
