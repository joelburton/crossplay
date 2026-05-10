/**
 * The shape of "things the dropdown menu can do to the current puzzle".
 *
 * `PuzzleView` writes a populated `PuzzleActions` (or null) into a ref
 * on every render; `App` passes that ref into `Menu`, which reads it
 * once when it opens. The ref hop is deliberate: `Menu` is mounted
 * inside `App`, but the actions depend on PuzzleView state (cursor
 * position, mode, puzzle meta). Subscribing the menu to those would
 * cause it to re-render on every cursor move, which is wasted work
 * given it's almost always closed.
 */

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
