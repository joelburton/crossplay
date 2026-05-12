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
  MarkSide,
  MarkType,
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

  if (m.type === "mark") {
    if (typeof m.row !== "number" || typeof m.col !== "number") return null;
    if (!Number.isInteger(m.row) || !Number.isInteger(m.col)) return null;
    if (m.row < 0 || m.col < 0) return null;
    if (m.side !== "right" && m.side !== "bottom") return null;
    if (m.markType !== null && m.markType !== "break" && m.markType !== "hyphen") return null;
    return {
      type: "mark",
      row: m.row,
      col: m.col,
      side: m.side as MarkSide,
      markType: m.markType as MarkType | null,
    };
  }

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

  if (m.type === "cursorMoved") {
    if (typeof m.row !== "number" || typeof m.col !== "number") return null;
    if (!Number.isInteger(m.row) || !Number.isInteger(m.col)) return null;
    if (m.row < 0 || m.col < 0) return null;
    if (typeof m.name !== "string" || !isHexColor(m.color)) return null;
    const name = sanitizeName(m.name);
    if (name.length === 0 || name.length > 32) return null;
    return { type: "cursorMoved", row: m.row, col: m.col, color: m.color, name };
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
  // Author-prefilled cells are immutable — the player can't edit the
  // template. Returning null so the inbound `fill` is silently
  // ignored and no broadcast happens.
  if (cell.given) return null;
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

/**
 * Apply a mark set/clear on one edge of a cell.
 *
 * Bumps the snapshot version once and returns a `CellChange` carrying
 * the full updated cell — same pattern as `applyFill`. `markType: null`
 * clears the mark. Returns null if the target isn't an open cell or if
 * the request is a no-op (same mark already in place, or clearing an
 * already-empty side).
 */
export function applyMark(
  entry: StoredBoard,
  msg: Extract<ClientMessage, { type: "mark" }>,
): CellChange | null {
  const { meta, snapshot } = entry.state;
  if (msg.row < 0 || msg.row >= meta.height) return null;
  if (msg.col < 0 || msg.col >= meta.width) return null;
  const cell = snapshot.cells[msg.row]![msg.col]!;
  if (cell.kind !== "cell") return null;
  const key = msg.side === "right" ? "markRight" : "markBottom";
  const current = cell[key];
  if (msg.markType === null) {
    if (current === undefined) return null;
    delete cell[key];
  } else {
    if (current === msg.markType) return null;
    cell[key] = msg.markType;
  }
  snapshot.version += 1;
  return { row: msg.row, col: msg.col, cell };
}

/** Reveal the solution letter at one cell. Sets `revealed: true`, clears
 *  `wrong` and `pencil`. Returns `null` if the cell is a block, has no
 *  solution, or is already in the post-reveal state (consistent with
 *  `applyCheck` / `applyClear`: don't re-broadcast no-ops). */
function revealAt(entry: StoredBoard, row: number, col: number): CellChange | null {
  const cell = entry.state.snapshot.cells[row]?.[col];
  if (!cell || cell.kind !== "cell") return null;
  // Given cells already contain the author's letter and aren't
  // considered "solved by reveal" — skip cleanly.
  if (cell.given) return null;
  const sols = entry.solution[row]?.[col];
  if (sols == null || sols.length === 0) return null;
  // Reveal writes the canonical (first) answer. For Schrödinger cells
  // the player may have typed an alternate that was already correct —
  // we still overwrite with the canonical to match how reveal works
  // for everyone else.
  const canonical = sols[0]!;
  if (cell.revealed && cell.fill === canonical && !cell.wrong && !cell.pencil) return null;
  cell.fill = canonical;
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
  if (cell.given) return null; // givens are author-correct by construction
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

/** True if `fill` is an acceptable answer for `sols`. `sols` is the
 *  per-cell answer array: length 1 for normal cells, length > 1 for
 *  Schrödinger cells. Each candidate accepts both an exact match and
 *  (for length > 1 candidates) the first letter alone — a long-
 *  standing NYT convention for rebus answers that saves typing on
 *  small screens. The fill stays whatever the player typed; only the
 *  check decision is affected. */
export function fillMatchesSolution(fill: string, sols: string[] | null | undefined): boolean {
  if (sols == null) return false;
  for (const sol of sols) {
    if (fill === sol) return true;
    if (sol.length > 1 && fill === sol[0]) return true;
  }
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
        // circled / shaded / given are author-defined and immutable
        // during play. They never get out of sync in practice, but we
        // restore them defensively so the comparator above matches.
        if (init.circled) live.circled = true;
        else delete live.circled;
        if (init.shaded) live.shaded = true;
        else delete live.shaded;
        if (init.given) live.given = true;
        else delete live.given;
        // Marks are player annotations — Clear wipes them along with
        // fills, restoring the initial (markless) state.
        if (init.markRight) live.markRight = init.markRight;
        else delete live.markRight;
        if (init.markBottom) live.markBottom = init.markBottom;
        else delete live.markBottom;
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
  if (a.kind === "block") {
    const bb = b as Extract<Cell, { kind: "block" }>;
    return !!a.hidden === !!bb.hidden;
  }
  // both are cells
  const bb = b as Extract<Cell, { kind: "cell" }>;
  return (
    a.number === bb.number &&
    a.fill === bb.fill &&
    !!a.revealed === !!bb.revealed &&
    !!a.wrong === !!bb.wrong &&
    !!a.pencil === !!bb.pencil &&
    !!a.circled === !!bb.circled &&
    !!a.shaded === !!bb.shaded &&
    !!a.given === !!bb.given &&
    (a.markRight ?? null) === (bb.markRight ?? null) &&
    (a.markBottom ?? null) === (bb.markBottom ?? null)
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

const HEARTBEAT_INTERVAL_MS = 30_000;
// Number of consecutive missed pongs we tolerate before terminating
// the socket. Bumped from 1 → 2 (window 30s → 90s) because Chrome /
// Safari aggressively throttle JS in backgrounded tabs (App Nap on
// macOS) and the auto-pong can be late. The previous 15s × 1 window
// produced spurious "X joined" feedbacks on long cryptic sessions
// (see memory `project_post_playtest_followups.md` item #7).
const MISSED_PONG_TOLERANCE = 2;

/** Per-message dispatch context. Every handler receives this plus the
 *  parsed (and narrowed) message. Module-level handlers keep the route
 *  body tiny and let unit tests drive each message type without
 *  spinning up Fastify. */
type DispatchContext = {
  db: DatabaseSync;
  entry: StoredBoard;
  socket: WebSocket;
};

type HandlerFor<T extends ClientMessage["type"]> = (
  ctx: DispatchContext,
  msg: Extract<ClientMessage, { type: T }>,
) => void;

function handleFill({ db, entry }: DispatchContext, msg: Extract<ClientMessage, { type: "fill" }>): void {
  const change = applyFill(entry, msg);
  if (change) {
    broadcastChanges(entry, [change]);
    markDirty(db, entry.id);
  }
}

function handleReveal({ db, entry }: DispatchContext, msg: Extract<ClientMessage, { type: "reveal" }>): void {
  const changes = applyReveal(entry, msg);
  broadcastChanges(entry, changes);
  if (changes.length > 0) markDirty(db, entry.id);
}

function handleCheck({ db, entry }: DispatchContext, msg: Extract<ClientMessage, { type: "check" }>): void {
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
}

function handleClear({ db, entry }: DispatchContext): void {
  const changes = applyClear(entry);
  broadcastChanges(entry, changes);
  if (changes.length > 0) markDirty(db, entry.id);
}

function handleMark({ db, entry }: DispatchContext, msg: Extract<ClientMessage, { type: "mark" }>): void {
  const change = applyMark(entry, msg);
  if (change) {
    broadcastChanges(entry, [change]);
    markDirty(db, entry.id);
  }
}

function handleChat({ db, entry }: DispatchContext, msg: Extract<ClientMessage, { type: "chat" }>): void {
  const ts = Date.now();
  entry.chat.push({ name: msg.name, color: msg.color, text: msg.text, ts });
  markDirty(db, entry.id);
  broadcast(entry, { type: "chatMessage", name: msg.name, color: msg.color, text: msg.text, ts });
}

function handleShowNotes({ entry }: DispatchContext): void {
  broadcast(entry, { type: "notesShown" });
}

function handleCursorMoved(
  { entry, socket }: DispatchContext,
  msg: Extract<ClientMessage, { type: "cursorMoved" }>,
): void {
  // Remember this socket's color/name so we can send a `cursorLeft` on
  // disconnect. Last write wins (a player can change their name in
  // chat; the latest cursorMoved reflects that).
  entry.cursorBySocket.set(socket, { color: msg.color, name: msg.name });
  // Broadcast to peers only — sender doesn't need to see its own
  // cursor (it owns the local one).
  const payload = JSON.stringify({
    type: "cursorMoved",
    row: msg.row,
    col: msg.col,
    color: msg.color,
    name: msg.name,
  } satisfies ServerMessage);
  for (const s of entry.sockets) {
    if (s !== socket && s.readyState === s.OPEN) s.send(payload);
  }
}

function handleHello({ entry, socket }: DispatchContext, msg: Extract<ClientMessage, { type: "hello" }>): void {
  const now = Date.now();
  // Opportunistic GC: keeps the map bounded for long-lived rooms with
  // high name churn (`Rando<NN>` defaults, etc.).
  pruneRecentHellos(entry.recentHellos, now, HELLO_PRUNE_AFTER_MS);
  const last = entry.recentHellos.get(msg.name);
  entry.recentHellos.set(msg.name, now);
  if (!shouldAnnounceHello(last, now, HELLO_DEBOUNCE_MS)) return;
  // Broadcast to others only — sender doesn't see their own join.
  const payload = JSON.stringify({
    type: "feedback",
    id: nextFeedbackId(entry),
    text: `${msg.name} joined`,
    level: "info",
    autoVanishMs: 5000,
  });
  for (const s of entry.sockets) {
    if (s !== socket && s.readyState === s.OPEN) s.send(payload);
  }
}

/** Typed dispatch table: one entry per ClientMessage variant. Adding a
 *  new message type is "add an entry here + a `handleX` function" —
 *  the mapped type forces exhaustiveness at compile time. */
const handlers: { [K in ClientMessage["type"]]: HandlerFor<K> } = {
  fill: handleFill,
  reveal: handleReveal,
  check: handleCheck,
  clear: handleClear,
  mark: handleMark,
  chat: handleChat,
  showNotes: handleShowNotes,
  hello: handleHello,
  cursorMoved: handleCursorMoved,
};

function dispatchMessage(ctx: DispatchContext, msg: ClientMessage): void {
  // The cast collapses the per-variant handler types — TS can't follow
  // the indirection through `handlers[msg.type]`, but the mapped type
  // above guarantees each handler accepts its own variant.
  const handler = handlers[msg.type] as (ctx: DispatchContext, msg: ClientMessage) => void;
  handler(ctx, msg);
}

export type WsRouteOptions = {
  /** Required: sqlite handle. Boards are loaded lazily from this on
   *  first connect to a given id. */
  db: DatabaseSync;
  // Override the per-connection ping cadence. The integration test lowers
  // this to drive the silent-disconnect path in milliseconds rather than
  // the production 30s.
  heartbeatIntervalMs?: number;
  // Override the missed-pong tolerance. Tests can set this to 1 to
  // mirror the legacy strict behavior; production uses
  // MISSED_PONG_TOLERANCE for backgrounded-tab leniency.
  missedPongTolerance?: number;
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
  const missedPongTolerance = opts.missedPongTolerance ?? MISSED_PONG_TOLERANCE;
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
      const openedAt = Date.now();
      req.log.info({ boardId: id, peers: entry.sockets.size }, "ws open");

      // Heartbeat: server pings every interval; browser auto-pongs. We
      // count consecutive missed pongs and terminate once they reach
      // `missedPongTolerance`. Default tolerance is 2 (window ≈ 90s with
      // a 30s interval) so backgrounded tabs whose JS is throttled
      // briefly don't get killed for a single late pong.
      let missedPongs = 0;
      // Diagnostic flag: did the heartbeat decide to kill this socket?
      // The close handler reads it so we can distinguish a missed-pong
      // termination from a peer/network close in the log line.
      let terminatedByHeartbeat = false;
      socket.on("pong", () => {
        missedPongs = 0;
      });
      const heartbeat = setInterval(() => {
        if (missedPongs >= missedPongTolerance) {
          terminatedByHeartbeat = true;
          req.log.warn(
            { boardId: id, missedPongs, heartbeatIntervalMs, missedPongTolerance },
            "ws heartbeat terminating socket (no pong in window)",
          );
          socket.terminate();
          return;
        }
        missedPongs += 1;
        try {
          socket.ping();
        } catch {
          terminatedByHeartbeat = true;
          req.log.warn({ boardId: id }, "ws heartbeat: socket.ping() threw, terminating");
          socket.terminate();
        }
      }, heartbeatIntervalMs);

      socket.on("message", (raw) => {
        const msg = parseMessage(raw);
        if (!msg) return;
        dispatchMessage({ db, entry, socket }, msg);
      });

      socket.on("close", (code: number, reasonBuf: Buffer) => {
        clearInterval(heartbeat);
        entry.sockets.delete(socket);
        const reason = reasonBuf?.length ? reasonBuf.toString("utf8") : "";
        req.log.info(
          {
            boardId: id,
            code,
            reason,
            terminatedByHeartbeat,
            durationMs: Date.now() - openedAt,
            peers: entry.sockets.size,
          },
          "ws close",
        );
        // Tell peers to drop our cursor frame. If we never sent a
        // cursorMoved (e.g. socket died before first move) there's
        // nothing to clean up.
        const cursor = entry.cursorBySocket.get(socket);
        entry.cursorBySocket.delete(socket);
        if (cursor) {
          broadcast(entry, { type: "cursorLeft", color: cursor.color });
        }
        // Last connection out: persist + drop the cache entry. A
        // future reconnect will lazy-load it again.
        if (entry.sockets.size === 0) {
          flushAndEvict(db, entry.id);
        }
      });
    },
  );
}
