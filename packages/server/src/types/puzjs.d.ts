declare module "puzjs" {
  type RawCell = string | { solution: string };
  type DecodedPuz = {
    grid: RawCell[][];
    meta: { title?: string; author?: string; copyright?: string; description?: string };
    /** Flat cell indices (`row * width + col`) for cells with the GEXT
     *  circle bit. Empirically what puzjs returns — the older
     *  boolean[][] shape declared here previously was wrong. */
    circles?: number[];
    /** Flat cell indices for cells with the GEXT shade bit. We don't
     *  support shading; `parsePuzBuffer` rejects when this is non-empty. */
    shades?: number[];
    clues: { across: (string | undefined)[]; down: (string | undefined)[] };
  };
  const Puz: {
    decode(bytes: Uint8Array | ArrayBuffer): DecodedPuz;
    encode(puzzle: unknown): Uint8Array;
  };
  export default Puz;
}
