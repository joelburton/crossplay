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
  collapseRebus: boolean;
  togglePencil: () => void;
  toggleCollapseRebus: () => void;
  clearBoard: () => void;
  revealLetter: () => void;
  revealWord: () => void;
  revealPuzzle: () => void;
  checkLetter: () => void;
  checkWord: () => void;
  checkPuzzle: () => void;
  showNotes: () => void;
  openRebus: () => void;
  showHelp: () => void;
  downloadIpuz: () => void;
  /** Open the print-friendly view of this board in a new tab. The
   *  print page is a standalone route at `/b/:id/print`; the user can
   *  then hit Cmd/Ctrl-P or click the "Print" button on that page. */
  printPuzzle: () => void;
  /** Only present for authed users. The server's share route requires
   *  membership, which anons can't have under Posture A — hiding the
   *  menu item entirely is the right UX. */
  openShare?: () => void;
  /** Open the shared scratchpad panel. Per-client toggle — opening it
   *  for yourself doesn't open it on peers. */
  openScratchpad: () => void;
};
