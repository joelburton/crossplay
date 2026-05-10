/**
 * Read and write the .ipuz crossword format (http://www.ipuz.org/).
 *
 * ipuz is the modern, JSON-based, unencumbered counterpart to the
 * legacy binary `.puz` format. We accept it as a second input format
 * (alongside .puz) and emit it for the future "download puzzle"
 * button.
 *
 * Scope today is the standard-crossword subset: square grid, integer
 * cell numbers, single-letter solutions, plain text clues. Any ipuz
 * feature outside that subset (rebus, circled or shaded cells, barred
 * grids, irregular/null cells, non-crossword `kind`) causes
 * `parseIpuzBuffer` to throw `IpuzUnsupportedError` so we can see what
 * real puzzles in the wild are using before deciding which to
 * support. Silent degradation would hide that signal.
 *
 * The pivot for both directions is the same `PuzzleState` + solution
 * grid that `parsePuzBuffer` produces, so anything downstream
 * (snapshot, ws, reveal/check) sees a single shape regardless of the
 * source format.
 */

import type { Cell, Clue, GridSnapshot, PuzzleMeta, PuzzleState } from "@crossplay/shared";

type ParseResult = {
  state: PuzzleState;
  solution: (string | null)[][];
};

/** Thrown for both malformed ipuz JSON and ipuz features we don't yet
 *  support. Callers should treat it as a 400-class error and surface
 *  `message` to the user. */
export class IpuzUnsupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IpuzUnsupportedError";
  }
}

function fail(msg: string): never {
  throw new IpuzUnsupportedError(msg);
}

const CROSSWORD_KIND = /(^|\/)crossword(#|$)/i;

type IpuzCellObject = {
  cell?: unknown;
  style?: Record<string, unknown>;
  value?: unknown;
};

function isPlainObject(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

/** Reject the ipuz `style` features we don't render. Anything we do
 *  encounter in real puzzles becomes a candidate to support later. */
function checkStyle(style: Record<string, unknown>, where: string): void {
  if (style.shapebg !== undefined) fail(`${where}: circled/shaded cells (style.shapebg) are not supported`);
  if (style.shading !== undefined) fail(`${where}: shaded cells (style.shading) are not supported`);
  if (style.barred !== undefined) fail(`${where}: barred grids (style.barred) are not supported`);
  if (style.color !== undefined) fail(`${where}: colored cells (style.color) are not supported`);
  if (style.imagebg !== undefined) fail(`${where}: image backgrounds (style.imagebg) are not supported`);
  if (style.image !== undefined) fail(`${where}: cell images (style.image) are not supported`);
  if (style.divided !== undefined) fail(`${where}: divided cells (style.divided) are not supported`);
}

/** Decode one ipuz clue entry. Accepts `[number, "text"]` and the
 *  longhand `{number, clue}` form. Rejects multi-cell clues
 *  (number as array) and anything else. */
function parseClue(entry: unknown, where: string): Clue {
  if (Array.isArray(entry)) {
    if (entry.length < 2) fail(`${where}: malformed clue tuple`);
    const [num, text] = entry;
    if (typeof num !== "number" || !Number.isInteger(num)) {
      fail(`${where}: clue number must be an integer (got ${JSON.stringify(num)})`);
    }
    if (typeof text !== "string") {
      fail(`${where}: clue text must be a string`);
    }
    return { number: num, text };
  }
  if (isPlainObject(entry)) {
    const num = entry.number;
    const text = entry.clue;
    if (Array.isArray(num)) fail(`${where}: multi-number clues are not supported`);
    if (typeof num !== "number" || !Number.isInteger(num)) {
      fail(`${where}: clue.number must be an integer`);
    }
    if (typeof text !== "string") {
      fail(`${where}: clue.clue must be a string`);
    }
    return { number: num, text };
  }
  fail(`${where}: unsupported clue entry shape`);
}

function parseClueList(arr: unknown, where: string): Clue[] {
  if (arr === undefined) return [];
  if (!Array.isArray(arr)) fail(`${where}: expected an array`);
  return arr.map((entry, i) => parseClue(entry, `${where}[${i}]`));
}

/** Pull the clue list under either capitalization. ipuz spec uses
 *  capitalized "Across"/"Down"; some authoring tools emit lowercase. */
function pickClues(clues: Record<string, unknown>, key: string): unknown {
  return clues[key] ?? clues[key.toLowerCase()];
}

/** Normalize one solution-grid cell to an uppercase letter or null
 *  (block). Rejects rebus (multi-character), object form with `value`
 *  longer than one char, and any cell shape we don't recognize. */
function parseSolutionCell(
  raw: unknown,
  blockChar: string,
  isBlock: boolean,
  where: string,
): string | null {
  if (isBlock) return null;
  let value: unknown = raw;
  if (isPlainObject(raw)) {
    if (raw.style && isPlainObject(raw.style)) checkStyle(raw.style, where);
    value = "value" in raw ? raw.value : raw.cell;
  }
  if (value === blockChar) {
    fail(`${where}: solution marks block where puzzle marks an open cell`);
  }
  if (typeof value !== "string") {
    fail(`${where}: solution cell must be a letter (got ${JSON.stringify(value)})`);
  }
  if (value.length === 0) {
    fail(`${where}: solution cell is empty`);
  }
  if (value.length > 1) {
    fail(`${where}: rebus solutions are not supported`);
  }
  return value.toUpperCase();
}

/**
 * Parse an ipuz JSON buffer into the same `{state, solution}` shape
 * `parsePuzBuffer` returns. Throws `IpuzUnsupportedError` on any
 * unsupported feature; the caller is expected to surface the message.
 *
 * @param id  Puzzle id used in `meta.id`.
 * @param buffer  Raw file bytes (UTF-8 JSON; BOM tolerated).
 */
export function parseIpuzBuffer(id: string, buffer: Buffer): ParseResult {
  let text = buffer.toString("utf8");
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (err) {
    fail(`invalid JSON: ${(err as Error).message}`);
  }
  if (!isPlainObject(data)) fail("ipuz root must be an object");

  const kinds = data.kind;
  if (!Array.isArray(kinds) || kinds.length === 0) {
    fail("missing `kind` (expected http://ipuz.org/crossword#1)");
  }
  if (!kinds.some((k) => typeof k === "string" && CROSSWORD_KIND.test(k))) {
    fail(`unsupported puzzle kind: ${JSON.stringify(kinds)} (only crossword is supported)`);
  }

  const dims = data.dimensions;
  if (!isPlainObject(dims)) fail("missing `dimensions`");
  const width = Number(dims.width);
  const height = Number(dims.height);
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    fail(`invalid dimensions: ${JSON.stringify(dims)}`);
  }

  const blockChar = typeof data.block === "string" ? data.block : "#";
  const emptyMarker = data.empty === undefined ? 0 : data.empty;

  const puzzleGrid = data.puzzle;
  if (!Array.isArray(puzzleGrid) || puzzleGrid.length !== height) {
    fail(`puzzle grid must have ${height} rows`);
  }
  const solutionGrid = data.solution;
  if (!Array.isArray(solutionGrid) || solutionGrid.length !== height) {
    fail(`solution grid must have ${height} rows (we don't yet support solver-only ipuz files)`);
  }

  const cells: Cell[][] = [];
  const solution: (string | null)[][] = [];
  for (let r = 0; r < height; r++) {
    const puzRow = puzzleGrid[r];
    const solRow = solutionGrid[r];
    if (!Array.isArray(puzRow) || puzRow.length !== width) {
      fail(`puzzle row ${r} must have ${width} cells`);
    }
    if (!Array.isArray(solRow) || solRow.length !== width) {
      fail(`solution row ${r} must have ${width} cells`);
    }
    const cellRow: Cell[] = [];
    const solOut: (string | null)[] = [];
    for (let c = 0; c < width; c++) {
      const where = `puzzle[${r}][${c}]`;
      const raw = puzRow[c];
      let cellValue: unknown = raw;
      if (isPlainObject(raw)) {
        const obj = raw as IpuzCellObject;
        if (obj.style && isPlainObject(obj.style)) checkStyle(obj.style, where);
        if (obj.value !== undefined) fail(`${where}: pre-filled cell values are not supported`);
        cellValue = obj.cell ?? emptyMarker;
      }

      if (cellValue === null) {
        fail(`${where}: null cells (irregular grids) are not supported`);
      }
      if (cellValue === blockChar) {
        cellRow.push({ kind: "block" });
        solOut.push(parseSolutionCell(solRow[c], blockChar, true, `solution[${r}][${c}]`));
        continue;
      }

      let number: number | null = null;
      if (typeof cellValue === "number" && Number.isInteger(cellValue) && cellValue > 0) {
        number = cellValue;
      } else if (cellValue !== emptyMarker && cellValue !== 0 && typeof cellValue !== "string") {
        // Strings that aren't the block char (e.g. "A1" cross-references) aren't in our subset.
        fail(`${where}: unrecognized cell value ${JSON.stringify(cellValue)}`);
      }

      cellRow.push({ kind: "cell", number, fill: null });
      solOut.push(parseSolutionCell(solRow[c], blockChar, false, `solution[${r}][${c}]`));
    }
    cells.push(cellRow);
    solution.push(solOut);
  }

  // Optional `saved` grid: in-progress player fills, parallel to
  // `solution`. Absent on freshly-authored puzzles; present on files
  // produced by our download endpoint mid-game. We apply letters into
  // the snapshot but ignore the `revealed`/`wrong`/`pencil` flags
  // (ipuz has no concept of them; we'd need a custom extension).
  const savedGrid = data.saved;
  if (savedGrid !== undefined) {
    if (!Array.isArray(savedGrid) || savedGrid.length !== height) {
      fail(`saved grid must have ${height} rows`);
    }
    for (let r = 0; r < height; r++) {
      const row = savedGrid[r];
      if (!Array.isArray(row) || row.length !== width) {
        fail(`saved row ${r} must have ${width} cells`);
      }
      for (let c = 0; c < width; c++) {
        const cell = cells[r]![c]!;
        if (cell.kind === "block") continue;
        const raw = row[c];
        let value: unknown = raw;
        if (isPlainObject(raw)) {
          if (raw.style && isPlainObject(raw.style)) checkStyle(raw.style, `saved[${r}][${c}]`);
          value = "value" in raw ? raw.value : raw.cell;
        }
        if (value === emptyMarker || value === 0 || value === null || value === "") continue;
        if (typeof value !== "string") {
          fail(`saved[${r}][${c}]: expected a letter (got ${JSON.stringify(value)})`);
        }
        if (value.length > 1) fail(`saved[${r}][${c}]: rebus saved values are not supported`);
        cells[r]![c] = { ...cell, fill: value.toUpperCase() };
      }
    }
  }

  const cluesRaw = data.clues;
  if (!isPlainObject(cluesRaw)) fail("missing `clues`");
  const acrossClues = parseClueList(pickClues(cluesRaw, "Across"), "clues.Across");
  const downClues = parseClueList(pickClues(cluesRaw, "Down"), "clues.Down");

  const meta: PuzzleMeta = {
    id,
    title: typeof data.title === "string" ? data.title : "",
    author: typeof data.author === "string" ? data.author : "",
    copyright: typeof data.copyright === "string" ? data.copyright : "",
    note: typeof data.notes === "string" ? data.notes : "",
    width,
    height,
    clues: { across: acrossClues, down: downClues },
  };

  const snapshot: GridSnapshot = { version: 0, cells };
  return { state: { meta, snapshot }, solution };
}

/**
 * Emit ipuz JSON for a puzzle. The output is the standard-crossword
 * subset: integer cell numbers, single-letter solutions, two clue
 * lists, no styling. Round-trips cleanly through `parseIpuzBuffer`.
 *
 * If any cells in the snapshot have a `fill`, they are emitted as the
 * ipuz `saved` grid so a downloaded mid-game file can be uploaded
 * elsewhere and continued. The `revealed`/`wrong`/`pencil` flags do
 * NOT round-trip — ipuz has no standard place for them and we don't
 * yet squat on a custom extension field.
 *
 * @param state  PuzzleState (meta + snapshot).
 * @param solution  Server-side solution grid (letters or null).
 */
export function writeIpuz(state: PuzzleState, solution: (string | null)[][]): string {
  const { meta, snapshot } = state;

  const puzzle = snapshot.cells.map((row) =>
    row.map((cell) => (cell.kind === "block" ? "#" : (cell.number ?? 0))),
  );

  const sol = solution.map((row) => row.map((c) => (c === null ? "#" : c.toUpperCase())));

  const hasFills = snapshot.cells.some((row) =>
    row.some((cell) => cell.kind === "cell" && cell.fill != null && cell.fill !== ""),
  );
  const saved = hasFills
    ? snapshot.cells.map((row) =>
        row.map((cell): string | number => {
          if (cell.kind === "block") return 0;
          return cell.fill ? cell.fill.toUpperCase() : 0;
        }),
      )
    : undefined;

  const out: Record<string, unknown> = {
    version: "http://ipuz.org/v2",
    kind: ["http://ipuz.org/crossword#1"],
  };
  if (meta.title) out.title = meta.title;
  if (meta.author) out.author = meta.author;
  if (meta.copyright) out.copyright = meta.copyright;
  if (meta.note) out.notes = meta.note;
  out.dimensions = { width: meta.width, height: meta.height };
  out.puzzle = puzzle;
  out.solution = sol;
  if (saved) out.saved = saved;
  out.clues = {
    Across: meta.clues.across.map((c) => [c.number, c.text]),
    Down: meta.clues.down.map((c) => [c.number, c.text]),
  };

  return JSON.stringify(out, null, 2);
}
