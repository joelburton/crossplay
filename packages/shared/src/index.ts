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

export type Direction = "across" | "down";

export type Cell =
  | { kind: "block" }
  | {
      kind: "cell";
      number: number | null;
      fill: string | null;
      revealed?: boolean;
      wrong?: boolean;
      pencil?: boolean;
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
  | { type: "chat"; name: string; color: string; text: string }
  | { type: "showNotes" }
  | { type: "hello"; name: string; color: string };

export type ServerMessage =
  | { type: "snapshot"; snapshot: GridSnapshot }
  | {
      type: "cellUpdate";
      row: number;
      col: number;
      cell: Cell;
      version: number;
      senderColor?: string;
    }
  | { type: "chatMessage"; name: string; color: string; text: string; ts: number }
  | { type: "notesShown" }
  | {
      type: "feedback";
      id: string;
      text: string;
      level: "info" | "warning" | "celebration";
      autoVanishMs?: number;
    };
