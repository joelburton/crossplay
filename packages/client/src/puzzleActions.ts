import type { PuzzleMeta } from "@crossplay/shared";

export type PuzzleActions = {
  meta: PuzzleMeta;
  mode: "pen" | "pencil";
  togglePencil: () => void;
  clearBoard: () => void;
  revealLetter: () => void;
  revealWord: () => void;
  revealPuzzle: () => void;
  checkLetter: () => void;
  checkWord: () => void;
  checkPuzzle: () => void;
  showNotes: () => void;
};
