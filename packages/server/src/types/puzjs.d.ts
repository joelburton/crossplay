declare module "puzjs" {
  type RawCell = string | { solution: string };
  type DecodedPuz = {
    grid: RawCell[][];
    meta: { title?: string; author?: string; copyright?: string; description?: string };
    circles?: boolean[][];
    shades?: boolean[][];
    clues: { across: (string | undefined)[]; down: (string | undefined)[] };
  };
  const Puz: {
    decode(bytes: Uint8Array | ArrayBuffer): DecodedPuz;
    encode(puzzle: unknown): Uint8Array;
  };
  export default Puz;
}
