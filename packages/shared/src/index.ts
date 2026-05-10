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
