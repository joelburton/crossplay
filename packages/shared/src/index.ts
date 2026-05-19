/**
 * Single source of truth for the client/server wire protocol.
 *
 * The server validates inbound messages against `ClientMessage` shapes in
 * `parseMessage` (see `packages/server/src/ws.ts`); the client constructs
 * them by hand. Both sides import the same types, so any rename here is
 * caught by `tsc` in both packages.
 *
 * Keep this file dependency‑free — no Node, no DOM, no framework imports —
 * so it stays a pure type module that either side can pull in.
 */

/** Cap on a single cell's fill / solution length, in characters.
 *  Single letters are 1; rebus answers up to MAX_REBUS_LEN. Both
 *  parsers and the server's `applyFill` enforce this; clients use it
 *  to size the rebus input. */
export const MAX_REBUS_LEN = 8;

/** Cap on the shared scratchpad text, in characters. The scratchpad is
 *  a small notes area (anagram scratch, cryptic clue annotations); the
 *  limit is a sanity ceiling — real usage is tiny — and gates both the
 *  client textarea and the server's `scratchpadEdit` handler. */
export const SCRATCHPAD_MAX_LEN = 10_000;

export type Direction = "across" | "down";

export type Cell =
  | {
      kind: "block";
      /** Irregular-grid "void" cell — functionally identical to a
       *  regular block (terminates words, unclickable, unfillable),
       *  but rendered as transparent space instead of a black square
       *  with an outline. Used to carve non-rectangular puzzle shapes
       *  (.ipuz `null` cells). */
      hidden?: boolean;
    }
  | {
      kind: "cell";
      number: number | null;
      fill: string | null;
      revealed?: boolean;
      wrong?: boolean;
      pencil?: boolean;
      /** Author-defined circle around the cell (common theme marker).
       *  Pure presentation: set at parse time, never mutated, ignored
       *  by reveal/check/clear/fill. */
      circled?: boolean;
      /** Author-defined background shading (alternative theme marker;
       *  ipuz `style.color` / .puz GEXT shade bit). Pure presentation
       *  like `circled`: set at parse time, never mutated. */
      shaded?: boolean;
      /** Author-prefilled cell: the `fill` arrived with the puzzle and
       *  is part of the template. The server's `applyFill` refuses to
       *  mutate it, fill_percent excludes it from both numerator and
       *  denominator, and the client renders the letter underlined. */
      given?: boolean;
      /** Player-drawn word-break / hyphen mark on the right edge of
       *  this cell (the boundary shared with the cell to the right).
       *  "break" renders as a thick line, "hyphen" as a small dash
       *  across the edge. Used in cryptics to annotate where a single
       *  grid entry breaks into multiple lexical words. Shared across
       *  collaborators (no per-player marks). */
      markRight?: "break" | "hyphen";
      /** Same as `markRight` but for the bottom edge (boundary with
       *  the cell below). */
      markBottom?: "break" | "hyphen";
    };

export type Clue = {
  number: number;
  text: string;
};

export type PuzzleMeta = {
  id: string;
  title: string;
  author: string;
  copyright: string;
  note: string;
  width: number;
  height: number;
  clues: {
    across: Clue[];
    down: Clue[];
  };
};

export type GridSnapshot = {
  version: number;
  cells: Cell[][];
};

export type PuzzleState = {
  meta: PuzzleMeta;
  snapshot: GridSnapshot;
};

export type Scope = "letter" | "word" | "puzzle";

export type MarkSide = "right" | "bottom";
export type MarkType = "break" | "hyphen";

export type ClientMessage =
  | {
      type: "fill";
      row: number;
      col: number;
      letter: string | null;
      // Reserved for future last-writer-wins / race-to-cell logic.
      // Currently sent by the client (snapshot.version at send time) and
      // type-validated by the server, but never compared to the server's
      // version. See code-review-1.md §1.5.
      clientVersion: number;
      senderColor?: string;
      pencil?: boolean;
    }
  | {
      type: "reveal";
      scope: Scope;
      row?: number;
      col?: number;
      dir?: Direction;
      senderColor?: string;
    }
  | {
      type: "check";
      scope: Scope;
      row?: number;
      col?: number;
      dir?: Direction;
    }
  | { type: "clear" }
  | {
      /** Set or clear a word-break / hyphen mark on one edge of a
       *  cell. `markType: null` clears. Mark state is shared across
       *  all collaborators (same model as fills, not per-player). */
      type: "mark";
      row: number;
      col: number;
      side: MarkSide;
      markType: MarkType | null;
    }
  | { type: "chat"; name: string; color: string; text: string }
  | { type: "showNotes" }
  | { type: "hello"; name: string; color: string }
  | { type: "cursorMoved"; row: number; col: number; color: string; name: string }
  /** Replace the shared scratchpad's text. Only honored when the
   *  sending socket currently holds the scratchpad lock; non-holder
   *  edits are silently dropped (the client disables the textarea
   *  when not the holder, so this is defense-in-depth). The full
   *  text is sent, not a diff — the scratchpad is small (capped at
   *  SCRATCHPAD_MAX_LEN) and only one writer holds the lock at a
   *  time, so OT/CRDT complexity isn't warranted. */
  | { type: "scratchpadEdit"; text: string }
  /** Claim the scratchpad lock — either from no one, from yourself
   *  (no-op), or by stealing it from the current holder. The server
   *  rejects a steal if the current holder has edited within the
   *  last second (active-typing grace); rejection surfaces as a
   *  warning feedback. `name`/`color` identify the new holder for
   *  the broadcast that follows on success. */
  | { type: "scratchpadTakeover"; name: string; color: string };

export type ServerMessage =
  | { type: "snapshot"; snapshot: GridSnapshot }
  /** Broadcast on the false → true transition of "every fillable cell
   *  matches a solution." Drives the celebratory modal on the client.
   *  Server-side state is in-memory only — players connecting to an
   *  already-solved board don't get a fresh broadcast (the modal is
   *  the *moment of solving*, not "this is a solved puzzle"). */
  | { type: "puzzleSolved" }
  | {
      type: "cellUpdate";
      row: number;
      col: number;
      cell: Cell;
      version: number;
      senderColor?: string;
    }
  | { type: "chatMessage"; name: string; color: string; text: string; ts: number }
  /** Catch-up payload sent once to a joining socket: the full persisted
   *  chat history for the board, oldest first. Clients should replace
   *  (not append to) their chat list on receipt — server is
   *  authoritative. Subsequent live messages arrive as `chatMessage`. */
  | {
      type: "chatHistory";
      messages: { name: string; color: string; text: string; ts: number }[];
    }
  | { type: "notesShown" }
  | {
      type: "feedback";
      id: string;
      text: string;
      level: "info" | "warning" | "celebration";
      autoVanishMs?: number;
    }
  // Pure presence: broadcast (to other sockets, not the sender) when a
  // peer's cursor moves. Not persisted, not version-stamped, not
  // replayed on reconnect. Receivers track the latest (row, col) per
  // `color` and render a thin frame on that cell.
  | { type: "cursorMoved"; row: number; col: number; color: string; name: string }
  // Broadcast when a peer's socket closes (clean disconnect, peer close,
  // or heartbeat termination). Receivers drop that color from their map.
  | { type: "cursorLeft"; color: string }
  /** Authoritative scratchpad state: current text plus who (if
   *  anyone) holds the edit lock. Sent on connect and rebroadcast
   *  after every edit / takeover / lock-release-on-disconnect.
   *  `lockedBy: null` means the scratchpad is unclaimed and anyone
   *  can take it over without contesting. */
  | {
      type: "scratchpadState";
      text: string;
      lockedBy: { name: string; color: string } | null;
    };
