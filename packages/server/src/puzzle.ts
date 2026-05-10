import Puz from "puzjs";
import type { Cell, Clue, GridSnapshot, PuzzleMeta, PuzzleState } from "@crossplay/shared";
import { IpuzUnsupportedError } from "./ipuz.js";

type ParseResult = {
  state: PuzzleState;
  solution: (string | null)[][];
};

/**
 * Parse a `.puz` file buffer into the shape we serve to clients.
 *
 * Returns two pieces:
 *   - `state`: meta + an empty grid snapshot. This is what we send to
 *     clients; it never contains the solution letters.
 *   - `solution`: a parallel grid of correct letters (or `null` for
 *     blocks). Stays server‑side and is consulted by `applyReveal` /
 *     `applyCheck`.
 *
 * Cell numbering is computed here, not read from puzjs. The library
 * exposes clue **text** keyed by number but does not tell us which cells
 * start a word — so we walk the grid in reading order and assign numbers
 * the standard way (a cell starts a word if its left/up neighbour is a
 * block or edge and its right/down neighbour is open).
 *
 * @param id  The puzzle id used in `meta.id` (slug for library puzzles,
 *            UUID for uploads).
 * @param buffer  Raw `.puz` bytes. Latin‑1 encoded — see CLAUDE.md
 *            ".puz format gotchas" before patching strings.
 */
export function parsePuzBuffer(id: string, buffer: Buffer): ParseResult {
  const decoded = Puz.decode(new Uint8Array(buffer));
  const rawGrid = decoded.grid;
  const height = rawGrid.length;
  const width = rawGrid[0]?.length ?? 0;

  // Detect rebus: puzjs returns object cells `{0:"B", solution:"BLOCK"}`
  // for rebus answers, with a multi-character `solution`. Without this
  // check, the multi-char letter silently flows through writeIpuz and
  // then fails when getBoardState re-parses the stored ipuz — surfacing
  // as a 500 long after upload. Match parseIpuzBuffer's rejection so the
  // upload route returns 400 with a clear message. Circles/shades from
  // puzjs are ignored at this layer (they don't break the round-trip —
  // writeIpuz never emits them — so silent drop matches today's UI).
  const solution: (string | null)[][] = rawGrid.map((row, r) =>
    row.map((cell, c) => {
      if (cell === ".") return null;
      const letter = typeof cell === "string" ? cell : cell.solution;
      if (typeof letter !== "string" || letter.length === 0) {
        throw new IpuzUnsupportedError(
          `solution[${r}][${c}]: empty or invalid solution letter`,
        );
      }
      if (letter.length > 1) {
        throw new IpuzUnsupportedError("rebus solutions are not supported");
      }
      return letter.toUpperCase();
    }),
  );

  const isBlock = (r: number, c: number) =>
    r < 0 || c < 0 || r >= height || c >= width || rawGrid[r]![c] === ".";

  const numbers: (number | null)[][] = Array.from({ length: height }, () =>
    Array.from({ length: width }, () => null as number | null),
  );

  const acrossClues: Clue[] = [];
  const downClues: Clue[] = [];
  let n = 0;
  for (let r = 0; r < height; r++) {
    for (let c = 0; c < width; c++) {
      if (isBlock(r, c)) continue;
      const startsAcross = isBlock(r, c - 1) && !isBlock(r, c + 1);
      const startsDown = isBlock(r - 1, c) && !isBlock(r + 1, c);
      if (startsAcross || startsDown) {
        n += 1;
        numbers[r]![c] = n;
        if (startsAcross) {
          const text = decoded.clues.across[n];
          if (text != null) acrossClues.push({ number: n, text });
        }
        if (startsDown) {
          const text = decoded.clues.down[n];
          if (text != null) downClues.push({ number: n, text });
        }
      }
    }
  }

  const cells: Cell[][] = rawGrid.map((row, r) =>
    row.map((cell, c): Cell => {
      if (cell === ".") return { kind: "block" };
      return { kind: "cell", number: numbers[r]![c] ?? null, fill: null };
    }),
  );

  const meta: PuzzleMeta = {
    id,
    title: decoded.meta.title ?? "",
    author: decoded.meta.author ?? "",
    copyright: decoded.meta.copyright ?? "",
    note: decoded.meta.description ?? "",
    width,
    height,
    clues: { across: acrossClues, down: downClues },
  };

  const snapshot: GridSnapshot = { version: 0, cells };

  return { state: { meta, snapshot }, solution };
}
