export type Direction = "across" | "down";

export type Cell =
  | { kind: "block" }
  | {
      kind: "cell";
      number: number | null;
      fill: string | null;
      revealed?: boolean;
      wrong?: boolean;
    };

export type Clue = {
  number: number;
  text: string;
};

export type PuzzleMeta = {
  id: string;
  title: string;
  author: string;
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
    }
  | {
      type: "reveal";
      scope: Scope;
      row?: number;
      col?: number;
      dir?: Direction;
    }
  | {
      type: "check";
      scope: Scope;
      row?: number;
      col?: number;
      dir?: Direction;
    }
  | { type: "clear" };

export type ServerMessage =
  | { type: "snapshot"; snapshot: GridSnapshot }
  | { type: "cellUpdate"; row: number; col: number; cell: Cell; version: number };
