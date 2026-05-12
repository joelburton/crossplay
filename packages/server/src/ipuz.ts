/**
 * Read and write the .ipuz crossword format (http://www.ipuz.org/).
 *
 * ipuz is the modern, JSON-based, unencumbered counterpart to the
 * legacy binary `.puz` format. We accept it as a second input format
 * (alongside .puz) and emit it for the future "download puzzle"
 * button.
 *
 * Scope today is the standard-crossword subset plus basic rebus,
 * circled cells, shaded cells, author-prefilled givens, per-cell
 * Schrödinger alternates, and irregular grids (null cells): square
 * grid, integer cell numbers, plain text clues, solutions/saved
 * values 1–MAX_REBUS_LEN uppercase letters, `style.shapebg ===
 * "circle"` and `style.color` as per-cell decorations, `value` on
 * the puzzle grid for givens, `{value, alternates}` on the solution
 * grid for multi-answer cells, and `null` on the puzzle grid for
 * cut-out cells (rendered transparent, otherwise behaves like a
 * block). Any ipuz feature outside that subset (barred grids,
 * non-crossword `kind`, unknown style keys or cell-object keys,
 * named style references) causes `parseIpuzBuffer` to throw
 * `IpuzUnsupportedError` so we can see what real puzzles in the
 * wild are using before deciding which to support. Silent
 * degradation would hide that signal — checks are whitelists, not
 * blacklists, so a new unknown feature surfaces as a 400 rather
 * than a quietly-stripped puzzle.
 *
 * The pivot for both directions is the same `PuzzleState` + solution
 * grid that `parsePuzBuffer` produces, so anything downstream
 * (snapshot, ws, reveal/check) sees a single shape regardless of the
 * source format.
 */

import { MAX_REBUS_LEN, type Cell, type Clue, type GridSnapshot, type PuzzleMeta, type PuzzleState } from "@crossplay/shared";

export { MAX_REBUS_LEN };

type ParseResult = {
  state: PuzzleState;
  /** Per cell: null for a block, otherwise an array of accepted
   *  answers. Length 1 for normal cells; length > 1 for Schrödinger
   *  cells (multiple valid answers). `applyCheck` accepts any element;
   *  `applyReveal` writes element 0 (the canonical answer). */
  solution: (string[] | null)[][];
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
  style?: unknown;
  value?: unknown;
  /** Schrödinger alternates: extra accepted answers, in addition to
   *  `value` (or the bare string in the solution grid). Custom
   *  extension — not in the ipuz spec proper, but a clear shape. */
  alternates?: unknown;
};

const ALLOWED_CELL_OBJECT_KEYS = new Set(["cell", "style", "value", "alternates"]);

function isPlainObject(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

/** Whitelist of ipuz `style` features we render. Everything else is
 *  rejected so unknown features surface as 400s rather than silent
 *  drops — when a real puzzle hits one of these, that's the signal
 *  to decide whether to support it. */
function parseStyle(style: unknown, where: string): { circled: boolean; shaded: boolean } {
  // Named styles (`style: "themeAccent"`) would need to be resolved
  // against the top-level `styles` table; we don't read that table, so
  // honoring the reference would be a silent drop.
  if (typeof style === "string") {
    fail(`${where}: named style references (style: "${style}") are not supported`);
  }
  if (!isPlainObject(style)) fail(`${where}: style must be an object`);
  let circled = false;
  let shaded = false;
  for (const [key, value] of Object.entries(style)) {
    if (key === "shapebg") {
      if (value === "circle") {
        circled = true;
      } else {
        fail(`${where}: style.shapebg=${JSON.stringify(value)} is not supported (only "circle")`);
      }
    } else if (key === "color") {
      // We treat any cell-background color as "shaded" (rendered with
      // our standard light-grey overlay). The author's specific color
      // is intentionally dropped — supporting per-cell color palettes
      // would multiply the design surface for very little gain, and
      // most real puzzles use shading only as a theme marker (same
      // role as circles).
      if (typeof value !== "string") {
        fail(`${where}: style.color must be a string`);
      }
      shaded = true;
    } else {
      fail(`${where}: style.${key} is not supported`);
    }
  }
  return { circled, shaded };
}

/** Reject any keys on a cell object beyond the ones we know how to
 *  read. Catches new ipuz features (marks, clue cross-references,
 *  etc.) at parse time rather than silently dropping them. */
function checkCellObjectKeys(obj: Record<string, unknown>, where: string): void {
  for (const key of Object.keys(obj)) {
    if (!ALLOWED_CELL_OBJECT_KEYS.has(key)) {
      fail(`${where}: unsupported cell-object key '${key}'`);
    }
  }
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

/** Validate one answer string for a solution cell. Returns the
 *  uppercased letter / rebus, or fails with a clear message. */
function validateAnswer(value: unknown, where: string): string {
  if (typeof value !== "string") {
    fail(`${where}: solution cell must be a letter (got ${JSON.stringify(value)})`);
  }
  if (value.length === 0) {
    fail(`${where}: solution cell is empty`);
  }
  if (value.length > MAX_REBUS_LEN) {
    fail(`${where}: rebus solutions over ${MAX_REBUS_LEN} characters are not supported`);
  }
  return value.toUpperCase();
}

/** Normalize one solution-grid cell to an array of accepted answers
 *  (length 1 for normal cells, > 1 for Schrödinger cells) or null
 *  (block). Accepts a bare string, or an object `{value, alternates}`
 *  where `alternates` is an array of additional accepted answers. */
function parseSolutionCell(
  raw: unknown,
  blockChar: string,
  isBlock: boolean,
  where: string,
): string[] | null {
  if (isBlock) return null;
  let value: unknown = raw;
  let alternates: unknown = undefined;
  if (isPlainObject(raw)) {
    checkCellObjectKeys(raw, where);
    if (raw.style !== undefined) parseStyle(raw.style, where);
    value = "value" in raw ? raw.value : raw.cell;
    alternates = raw.alternates;
  }
  if (value === blockChar) {
    fail(`${where}: solution marks block where puzzle marks an open cell`);
  }
  const out: string[] = [validateAnswer(value, where)];
  if (alternates !== undefined) {
    if (!Array.isArray(alternates)) {
      fail(`${where}: alternates must be an array`);
    }
    for (let i = 0; i < alternates.length; i++) {
      const alt = validateAnswer(alternates[i], `${where}.alternates[${i}]`);
      if (!out.includes(alt)) out.push(alt);
    }
  }
  return out;
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
  const solution: (string[] | null)[][] = [];
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
    const solOut: (string[] | null)[] = [];
    for (let c = 0; c < width; c++) {
      const where = `puzzle[${r}][${c}]`;
      const raw = puzRow[c];
      let cellValue: unknown = raw;
      let circled = false;
      let shaded = false;
      let given: string | undefined;
      if (isPlainObject(raw)) {
        const obj = raw as IpuzCellObject;
        checkCellObjectKeys(raw, where);
        if (obj.style !== undefined) {
          ({ circled, shaded } = parseStyle(obj.style, where));
        }
        if (obj.value !== undefined) {
          // Pre-filled (given) cells: the author seeds a letter that
          // the player can't edit. We store it as `fill` + `given:
          // true`; applyFill refuses to mutate, fillPercent skips,
          // and the client renders it underlined.
          given = validateAnswer(obj.value, `${where}.value`);
        }
        cellValue = obj.cell ?? emptyMarker;
      }

      if (cellValue === null) {
        // Irregular-grid void cell: same word-boundary / unfillable
        // behavior as a block, but rendered as transparent space.
        // Decoration / value flags are nonsensical here — reject so a
        // typo in the puzzle file surfaces clearly rather than getting
        // silently rendered into nothing.
        if (circled) fail(`${where}: circled null cells are not supported`);
        if (shaded) fail(`${where}: shaded null cells are not supported`);
        if (given !== undefined) fail(`${where}: null cells cannot have a value`);
        cellRow.push({ kind: "block", hidden: true });
        solOut.push(parseSolutionCell(solRow[c], blockChar, true, `solution[${r}][${c}]`));
        continue;
      }
      if (cellValue === blockChar) {
        if (circled) fail(`${where}: circled blocks are not supported`);
        if (shaded) fail(`${where}: shaded blocks are not supported`);
        if (given !== undefined) fail(`${where}: blocks cannot have a value`);
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

      cellRow.push({
        kind: "cell",
        number,
        fill: given ?? null,
        ...(circled ? { circled: true } : {}),
        ...(shaded ? { shaded: true } : {}),
        ...(given !== undefined ? { given: true } : {}),
      });
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
  // Given cells already have their author-prefilled fill from the
  // puzzle grid and are skipped here — `saved` is for player typing.
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
        if (cell.given) continue;
        const raw = row[c];
        let value: unknown = raw;
        if (isPlainObject(raw)) {
          checkCellObjectKeys(raw, `saved[${r}][${c}]`);
          if (raw.style !== undefined) parseStyle(raw.style, `saved[${r}][${c}]`);
          value = "value" in raw ? raw.value : raw.cell;
        }
        if (value === emptyMarker || value === 0 || value === null || value === "") continue;
        if (typeof value !== "string") {
          fail(`saved[${r}][${c}]: expected a letter (got ${JSON.stringify(value)})`);
        }
        if (value.length > MAX_REBUS_LEN) {
          fail(`saved[${r}][${c}]: saved values over ${MAX_REBUS_LEN} characters are not supported`);
        }
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
export function writeIpuz(state: PuzzleState, solution: (string[] | null)[][]): string {
  const { meta, snapshot } = state;

  // Decorations (circle / shading) and givens need the object form so
  // they survive the round-trip through the stored ipuz blob — boards
  // are flushed as canonical ipuz on every idle tick, and a flat-
  // number representation would erase them.
  const puzzle = snapshot.cells.map((row) =>
    row.map((cell): null | string | number | Record<string, unknown> => {
      if (cell.kind === "block") return cell.hidden ? null : "#";
      const value = cell.number ?? 0;
      const style: Record<string, unknown> = {};
      if (cell.circled) style.shapebg = "circle";
      if (cell.shaded) style.color = "#dddddd";
      const hasStyle = Object.keys(style).length > 0;
      if (!hasStyle && !cell.given) return value;
      const obj: Record<string, unknown> = { cell: value };
      if (hasStyle) obj.style = style;
      if (cell.given && cell.fill) obj.value = cell.fill.toUpperCase();
      return obj;
    }),
  );

  // Solution: walk in parallel with the snapshot so hidden blocks
  // emit `null` (matching the puzzle grid) while visible blocks emit
  // "#". A reader that loses the parallel relationship between the
  // two grids would silently drop the irregular shape.
  const sol = solution.map((row, r) =>
    row.map((answers, c): null | string | number | Record<string, unknown> => {
      if (answers === null) {
        const cell = snapshot.cells[r]?.[c];
        return cell?.kind === "block" && cell.hidden ? null : "#";
      }
      const primary = answers[0]!.toUpperCase();
      if (answers.length === 1) return primary;
      return {
        value: primary,
        alternates: answers.slice(1).map((a) => a.toUpperCase()),
      };
    }),
  );

  // Only emit `saved` for player typing — given letters are part of
  // the template, not user state, and would round-trip through `value`
  // on the puzzle grid above.
  const hasFills = snapshot.cells.some((row) =>
    row.some(
      (cell) => cell.kind === "cell" && !cell.given && cell.fill != null && cell.fill !== "",
    ),
  );
  const saved = hasFills
    ? snapshot.cells.map((row) =>
        row.map((cell): string | number => {
          if (cell.kind === "block") return 0;
          if (cell.given) return 0;
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
