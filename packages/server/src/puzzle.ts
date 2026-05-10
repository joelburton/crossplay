import Puz from "puzjs";
import type { Cell, Clue, GridSnapshot, PuzzleMeta, PuzzleState } from "@crossplay/shared";

type ParseResult = {
  state: PuzzleState;
  solution: (string | null)[][];
};

export function parsePuzBuffer(id: string, buffer: Buffer): ParseResult {
  const decoded = Puz.decode(new Uint8Array(buffer));
  const rawGrid = decoded.grid;
  const height = rawGrid.length;
  const width = rawGrid[0]?.length ?? 0;

  const solution: (string | null)[][] = rawGrid.map((row) =>
    row.map((cell) => {
      if (cell === ".") return null;
      const letter = typeof cell === "string" ? cell : cell.solution;
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
    width,
    height,
    clues: { across: acrossClues, down: downClues },
  };

  const snapshot: GridSnapshot = { version: 0, cells };

  return { state: { meta, snapshot }, solution };
}
