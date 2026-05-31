/**
 * NYT crossword fetch + convert. Pulls daily puzzle metadata and a
 * single puzzle by id from the NYT's v3 / v6 web endpoints (same
 * surface the nytxw_puz Python tool uses), and converts the v6
 * response into crossplay's `PuzzleState` + parallel solution grid —
 * the same shape `parseIpuzBuffer` returns.
 *
 * Auth is by cookie. Callers pass an `NytCookieJar` (a flat map of
 * cookie name → value), which we serialize into the request's
 * `Cookie:` header. The shape matches what the Python tool's
 * `~/nytxw_puz.cookies.json` writes; the CLI script reads that file,
 * and the HTTP route reads the same JSON shape out of `users.nyt_cookie`.
 *
 * Errors are typed so callers (route layer / CLI) can map them to the
 * right surface:
 *   - NytAuthError       — cookies expired / anti-bot challenge served
 *   - NytNoPuzzleError   — no Normal puzzle for that date
 *   - NytFetchError      — everything else (network / unexpected body)
 */

import { PNG } from "pngjs";
import type { Cell, Clue, PuzzleState } from "@crossplay/shared";

const LIST_API =
  "https://www.nytimes.com/svc/crosswords/v3/puzzles.json" +
  "?publish_type=daily&sort_order=asc&sort_by=print_date" +
  "&date_start=START&date_end=END";

// NYT cell-type codes (from nytxw_puz/nyt.py).
const NYT_BLOCK = 0;
const NYT_NORMAL = 1;
const NYT_CIRCLED = 2;
const NYT_GRAY = 3;
const NYT_INVISIBLE = 4;

/** Flat cookie jar — `{name: value}`. Same shape the Python tool's
 *  cache file uses, so users can paste the file contents straight into
 *  their `users.nyt_cookie` column. */
export type NytCookieJar = Record<string, string>;

export class NytAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NytAuthError";
  }
}

export class NytNoPuzzleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NytNoPuzzleError";
  }
}

export class NytFetchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NytFetchError";
  }
}

export type NytListEntry = {
  puzzleId: number;
  printDate: string;
  formatType: string;
};

type ListResponse = {
  results?: Array<{
    puzzle_id: number;
    print_date: string;
    format_type: string;
  }>;
};

type NytClue = {
  text: string | Array<string | { plain?: string }> | { plain?: string };
  direction?: string;
  label?: string;
};

type NytCell = {
  type?: number;
  answer?: string;
  label?: string;
  clues?: number[];
  moreAnswers?: { valid?: string[] };
};

type NytPuzzleBody = {
  cells: NytCell[];
  clues: NytClue[];
  dimensions: { width: number; height: number };
  /** Present when the puzzle has raster overlays — currently observed
   *  carrying theme circles drawn on top of shaded cells, which the
   *  per-cell `type` field can't express (its codes are mutually
   *  exclusive). The value is a 1-based index into the response's
   *  `assets` array. */
  overlays?: { beforeStart?: number };
};

type NytPuzzleResponse = {
  body: NytPuzzleBody[];
  assets?: Array<{ uri: string }>;
  publicationDate?: string;
  title?: string;
  editor?: string;
  copyright?: string;
  constructors?: string[];
  notes?: Array<{ text?: string }>;
};

function cookieHeader(jar: NytCookieJar): string {
  return Object.entries(jar)
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
}

/** Internal GET wrapper. Sends the cookie jar and a plain browser UA
 *  (NYT serves an anti-bot challenge to default UAs even with valid
 *  cookies); maps the common non-JSON / non-OK responses to the typed
 *  error classes so callers don't have to. */
async function nytGetJson<T>(url: string, jar: NytCookieJar): Promise<T> {
  let resp: Response;
  try {
    resp = await fetch(url, {
      headers: {
        Cookie: cookieHeader(jar),
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
          "(KHTML, like Gecko) Chrome/125.0 Safari/537.36",
        Referer: "https://www.nytimes.com/crosswords",
        Accept: "application/json",
      },
    });
  } catch (err) {
    throw new NytFetchError(
      `network error talking to NYT: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (resp.status === 401 || resp.status === 403) {
    throw new NytAuthError(
      `NYT rejected the request (${resp.status}). Your NYT cookie has likely expired — refresh it.`,
    );
  }
  if (!resp.ok) {
    throw new NytFetchError(`HTTP ${resp.status} ${resp.statusText} for ${url}`);
  }
  const text = await resp.text();
  // The anti-bot path returns an HTML challenge page with status 200.
  // Treat any non-JSON body as an auth failure so the user gets a
  // useful error instead of a parse stack trace.
  const trimmed = text.trimStart();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
    throw new NytAuthError(
      "NYT served a non-JSON response — your cookie has likely expired or hit a bot challenge.",
    );
  }
  try {
    return JSON.parse(text) as T;
  } catch (err) {
    throw new NytFetchError(
      `non-JSON response from NYT: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** Subset of nytxw_puz's HTML_TO_TEXT_RULES. Skips the Latin-1
 *  transliteration table (ipuz is UTF-8, so accents / em-dashes /
 *  symbols ride through unchanged). */
function htmlToText(s: string): string {
  let out = s;
  out = out.replace(/<i>(.*?)<\/i>/g, "_$1_");
  out = out.replace(/<em>(.*?)<\/em>/g, "_$1_");
  out = out.replace(/<sub>(.*?)<\/sub>/g, "$1");
  out = out.replace(/<sup>([0-9 ]+)<\/sup>/g, "^$1");
  out = out.replace(/<sup>(.*?)<\/sup>/g, "$1");
  out = out.replace(/<br( \/)?>/g, " / ");
  out = out.replace(/<s>(.*?)<\/s>/g, "[*cross out* $1]");
  out = out.replace(/<[^>]+>/g, "");
  out = out.replace(/&nbsp;/g, " ");
  out = out.replace(/&quot;/g, '"');
  out = out.replace(/&mdash;/g, "—");
  out = out.replace(/&amp;/g, "&");
  out = out.replace(/&vert;/g, "|");
  out = out.replace(/&lt;/g, "<");
  out = out.replace(/&gt;/g, ">");
  out = out.replace(/&bull;/g, "*");
  out = out.replace(/&#(\d+);/g, (_, n: string) => String.fromCharCode(Number(n)));
  out = out.replace(/&#x([0-9a-fA-F]+);/g, (_, n: string) =>
    String.fromCharCode(parseInt(n, 16)),
  );
  return out;
}

function clueText(text: NytClue["text"]): string {
  let t: unknown = text;
  if (Array.isArray(t)) t = t[0];
  if (t && typeof t === "object") t = (t as { plain?: string }).plain ?? "";
  if (typeof t !== "string") t = "";
  return htmlToText(t as string);
}

function buildTitle(meta: NytPuzzleResponse): string {
  const nytTitle = meta.title || "Untitled";
  if (meta.publicationDate) {
    const [y, m, d] = meta.publicationDate.split("-").map(Number);
    const date = new Date(Date.UTC(y!, m! - 1, d!));
    const dow = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][date.getUTCDay()];
    const yy = String(y! % 100).padStart(2, "0");
    return `NYT ${dow} ${m}/${d}/${yy}: ${nytTitle}`;
  }
  return `NYT: ${nytTitle}`;
}

function buildAuthor(meta: NytPuzzleResponse): string {
  const constructors = (meta.constructors ?? []).join(", ");
  if (meta.editor) return constructors + " / " + meta.editor;
  return constructors;
}

function buildNotes(meta: NytPuzzleResponse): string {
  return (meta.notes ?? [])
    .map((n) => n.text)
    .filter((t): t is string => typeof t === "string")
    .join("\n\n");
}

/** Translate NYT v6 cells+clues into a PuzzleState + parallel solution
 *  grid that `writeIpuz` consumes. Exported for unit testing — most
 *  callers go through `fetchNytPuzzleById` or `fetchNytPuzzleForDate`. */
export function nytResponseToPuzzleState(
  resp: NytPuzzleResponse,
  fallbackId: string,
): { state: PuzzleState; solution: (string[] | null)[][] } {
  const body = resp.body[0];
  if (!body) throw new NytFetchError("missing body[0] in puzzle response");
  const width = body.dimensions.width;
  const height = body.dimensions.height;
  if (body.cells.length !== width * height) {
    throw new NytFetchError(
      `cell count ${body.cells.length} != width*height ${width * height}`,
    );
  }

  const cells: Cell[][] = [];
  const solution: (string[] | null)[][] = [];
  for (let r = 0; r < height; r++) {
    const cellRow: Cell[] = [];
    const solRow: (string[] | null)[] = [];
    for (let c = 0; c < width; c++) {
      const nc = body.cells[r * width + c]!;
      const type = nc.type ?? NYT_BLOCK;
      const isBlock = type === NYT_BLOCK || type === NYT_INVISIBLE;
      const hasAnswer = typeof nc.answer === "string" && nc.answer.length > 0;
      if (isBlock || !hasAnswer) {
        cellRow.push(
          type === NYT_INVISIBLE
            ? { kind: "block", hidden: true }
            : { kind: "block" },
        );
        solRow.push(null);
        continue;
      }

      const primary = nc.answer!.toUpperCase();
      const alternates = (nc.moreAnswers?.valid ?? [])
        .map((a) => a.toUpperCase())
        .filter((a) => a !== primary);
      const answers = [primary, ...alternates];

      const number = nc.label ? Number(nc.label) : null;
      const cell: Cell = {
        kind: "cell",
        number: Number.isInteger(number) && number! > 0 ? number : null,
        fill: null,
        ...(type === NYT_CIRCLED ? { circled: true } : {}),
        ...(type === NYT_GRAY ? { shaded: true } : {}),
      };
      // Reference NYT_NORMAL so a future split between "normal" and a
      // new type is a compile-time signal rather than a silent fall-
      // through into the default cell branch.
      void NYT_NORMAL;
      cellRow.push(cell);
      solRow.push(answers);
    }
    cells.push(cellRow);
    solution.push(solRow);
  }

  const across: Clue[] = [];
  const down: Clue[] = [];
  for (const clue of body.clues) {
    const dir = (clue.direction ?? "").toLowerCase();
    const num = clue.label ? Number(clue.label) : NaN;
    if (!Number.isInteger(num) || num <= 0) continue;
    const entry = { number: num, text: clueText(clue.text) };
    if (dir === "across") across.push(entry);
    else if (dir === "down") down.push(entry);
  }
  across.sort((a, b) => a.number - b.number);
  down.sort((a, b) => a.number - b.number);

  const id = resp.publicationDate ?? fallbackId;
  const state: PuzzleState = {
    meta: {
      id,
      title: buildTitle(resp),
      author: buildAuthor(resp),
      copyright: resp.copyright
        ? `© ${resp.copyright}, The New York Times`
        : "",
      note: buildNotes(resp),
      width,
      height,
      clues: { across, down },
    },
    snapshot: { version: 0, cells },
  };
  return { state, solution };
}

/** List daily puzzles in `[start, end]` inclusive. Dates are
 *  `YYYY-MM-DD`. Each entry's `formatType` is `"Normal"` for playable
 *  crosswords; non-Normal results (occasional PDF-only days) are left
 *  in so the caller can decide what to do. */
export async function fetchNytPuzzleList(
  jar: NytCookieJar,
  start: string,
  end: string,
): Promise<NytListEntry[]> {
  const url = LIST_API.replace("START", start).replace("END", end);
  const data = await nytGetJson<ListResponse>(url, jar);
  return (data.results ?? []).map((r) => ({
    puzzleId: r.puzzle_id,
    printDate: r.print_date,
    formatType: r.format_type,
  }));
}

/** Decoded markings from a NYT overlay PNG.
 *
 *  - `circles`: cells with a theme-marker circle drawn on them (most
 *    common use of the overlay channel — circles-on-shaded cells that
 *    the per-cell `type` field can't represent).
 *  - `barsRight` / `barsBottom`: cells with a thick author-drawn line
 *    on their right / bottom edge. NYT uses these in some themed
 *    puzzles as a *visual* separator that doesn't actually break a
 *    word (the JSON's `clues` arrays span across them). Maps directly
 *    onto our `markRight` / `markBottom` "break" marks.
 *
 *  All three sets use `"row,col"` string keys. */
export type OverlayMarkings = {
  circles: Set<string>;
  barsRight: Set<string>;
  barsBottom: Set<string>;
};

/** Decode the raster overlay PNG that some NYT puzzles ship instead of
 *  (or in addition to) per-cell `type` flags.
 *
 *  Background: NYT's v6 cell-`type` field is mutually exclusive
 *  (1=normal, 2=circled, 3=gray), so it can't represent a cell that is
 *  both circled AND shaded — nor can it represent an inter-cell bar at
 *  all. When a puzzle needs any of that, NYT bakes the markings into a
 *  PNG overlay (`body.overlays.beforeStart` indexes into the response's
 *  `assets` array) and composites it over the SVG grid.
 *
 *  We extract every opaque connected component, then classify by
 *  bounding-box aspect ratio: roughly square → circle; tall+narrow →
 *  vertical bar; short+wide → horizontal bar. Centroids map back to
 *  cell positions (for circles) or to inter-cell boundaries (for bars).
 *
 *  Coordinate model: NYT's SVG uses 33-pixel cells with a 3-pixel
 *  border around the grid (viewBox `0 0 (6+33W) (6+33H)`). The overlay
 *  PNG is a uniform scaling of that viewBox; we derive the scale from
 *  the PNG width and known grid width. Sized correctly for any grid
 *  (15×15 daily, 21×21 Sunday, etc.).
 *
 *  Tolerant of small artifacts: components under ~50 pixels are
 *  rejected (well below a real circle's outline ~85+ pixels or a real
 *  bar ~33+ pixels at scale=1 viewBox pixels).
 *
 *  Exported for unit testing. */
export function detectOverlayMarkings(
  png: PNG,
  width: number,
  height: number,
): OverlayMarkings {
  // 33-px cells + 3-px border → viewBox span of 6+33*N.
  const viewBoxW = 6 + 33 * width;
  const scale = png.width / viewBoxW;
  const MIN_COMPONENT_PIXELS = 50;
  // Aspect-ratio threshold for "this component is a bar, not a circle".
  // Real bars span the full cell (~33 SVG px) with a stroke of 1–3 px,
  // so height/width is 10+; circles are roughly square (~1). 3× is a
  // safe split that tolerates anti-aliasing fuzz at the bar's ends.
  const BAR_ASPECT_RATIO = 3;

  const W = png.width;
  const H = png.height;
  const visited = new Uint8Array(W * H);
  const alphaAt = (x: number, y: number): number =>
    x < 0 || x >= W || y < 0 || y >= H ? 0 : png.data[(y * W + x) * 4 + 3]!;

  const circles = new Set<string>();
  const barsRight = new Set<string>();
  const barsBottom = new Set<string>();
  const stack: number[] = [];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const start = y * W + x;
      if (visited[start] || alphaAt(x, y) < 32) continue;
      stack.length = 0;
      stack.push(start);
      visited[start] = 1;
      let sumX = 0, sumY = 0, count = 0;
      let minX = x, maxX = x, minY = y, maxY = y;
      while (stack.length) {
        const i = stack.pop()!;
        const px = i % W;
        const py = (i - px) / W;
        sumX += px;
        sumY += py;
        count++;
        if (px < minX) minX = px;
        if (px > maxX) maxX = px;
        if (py < minY) minY = py;
        if (py > maxY) maxY = py;
        // 4-connected neighbours; diagonal connectivity isn't needed
        // because the outline / bar stroke is thicker than a single pixel.
        if (px + 1 < W) {
          const ni = i + 1;
          if (!visited[ni] && alphaAt(px + 1, py) >= 32) { visited[ni] = 1; stack.push(ni); }
        }
        if (px > 0) {
          const ni = i - 1;
          if (!visited[ni] && alphaAt(px - 1, py) >= 32) { visited[ni] = 1; stack.push(ni); }
        }
        if (py + 1 < H) {
          const ni = i + W;
          if (!visited[ni] && alphaAt(px, py + 1) >= 32) { visited[ni] = 1; stack.push(ni); }
        }
        if (py > 0) {
          const ni = i - W;
          if (!visited[ni] && alphaAt(px, py - 1) >= 32) { visited[ni] = 1; stack.push(ni); }
        }
      }
      if (count < MIN_COMPONENT_PIXELS) continue;
      const bboxW = maxX - minX + 1;
      const bboxH = maxY - minY + 1;
      const cxSvg = sumX / count / scale;
      const cySvg = sumY / count / scale;

      if (bboxH >= BAR_ASPECT_RATIO * bboxW) {
        // Vertical bar on a cell boundary. Centroid x ≈ 3 + 33*b where
        // b is the 1-based boundary index between cols (b-1) and b.
        const boundary = Math.round((cxSvg - 3) / 33);
        const row = Math.floor((cySvg - 3) / 33);
        const leftCol = boundary - 1;
        if (row >= 0 && row < height && leftCol >= 0 && leftCol < width - 1) {
          barsRight.add(`${row},${leftCol}`);
        }
      } else if (bboxW >= BAR_ASPECT_RATIO * bboxH) {
        // Horizontal bar on a cell boundary. Mirror of the above on
        // the y-axis.
        const boundary = Math.round((cySvg - 3) / 33);
        const col = Math.floor((cxSvg - 3) / 33);
        const topRow = boundary - 1;
        if (col >= 0 && col < width && topRow >= 0 && topRow < height - 1) {
          barsBottom.add(`${topRow},${col}`);
        }
      } else {
        // Approximately square → circle. Centroid is at the cell
        // center, i.e. 3 + 33*(c+0.5).
        const col = Math.round((cxSvg - 3) / 33 - 0.5);
        const row = Math.round((cySvg - 3) / 33 - 0.5);
        if (row >= 0 && row < height && col >= 0 && col < width) {
          circles.add(`${row},${col}`);
        }
      }
    }
  }
  return { circles, barsRight, barsBottom };
}

/** Thin wrapper kept for backward compatibility — older callers (and
 *  tests) only cared about circles. New code should call
 *  `detectOverlayMarkings` directly to also pick up bars. */
export function detectOverlayCircles(
  png: PNG,
  width: number,
  height: number,
): Set<string> {
  return detectOverlayMarkings(png, width, height).circles;
}

/** Fetch and decode a NYT overlay PNG. Returns empty sets on any
 *  non-fatal failure (decode error, network blip) since overlay data
 *  is decorative, not load-bearing. */
async function fetchOverlayMarkings(
  url: string,
  jar: NytCookieJar,
  width: number,
  height: number,
): Promise<OverlayMarkings> {
  const empty: OverlayMarkings = {
    circles: new Set(),
    barsRight: new Set(),
    barsBottom: new Set(),
  };
  let resp: Response;
  try {
    resp = await fetch(url, {
      headers: {
        Cookie: cookieHeader(jar),
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
          "(KHTML, like Gecko) Chrome/125.0 Safari/537.36",
        Referer: "https://www.nytimes.com/crosswords",
      },
    });
  } catch {
    return empty;
  }
  if (!resp.ok) return empty;
  let png: PNG;
  try {
    const buf = Buffer.from(await resp.arrayBuffer());
    png = PNG.sync.read(buf);
  } catch {
    return empty;
  }
  return detectOverlayMarkings(png, width, height);
}

/** Apply detected overlay markings to a cell grid in place.
 *  - Circles set `circled: true` on the named cell.
 *  - Right/bottom bars set `markRight`/`markBottom` to `"break"` on
 *    the named cell, which renders identically to a player-drawn
 *    word-break mark. We accept that a player could later clear an
 *    author-set bar by pressing `|` / `_`; the alternative (a separate
 *    immutable field) didn't seem worth a Cell-type change for the
 *    handful of NYT puzzles that ship bars.
 *  Exported for testing. */
export function applyOverlayMarkings(cells: Cell[][], m: OverlayMarkings): void {
  for (const key of m.circles) {
    const [r, c] = key.split(",").map(Number) as [number, number];
    const cell = cells[r]?.[c];
    if (cell && cell.kind === "cell") cell.circled = true;
  }
  for (const key of m.barsRight) {
    const [r, c] = key.split(",").map(Number) as [number, number];
    const cell = cells[r]?.[c];
    if (cell && cell.kind === "cell") cell.markRight = "break";
  }
  for (const key of m.barsBottom) {
    const [r, c] = key.split(",").map(Number) as [number, number];
    const cell = cells[r]?.[c];
    if (cell && cell.kind === "cell") cell.markBottom = "break";
  }
}

/** Backward-compat wrapper for tests that still consume circles only. */
export function applyOverlayCircles(cells: Cell[][], circled: Set<string>): void {
  applyOverlayMarkings(cells, {
    circles: circled,
    barsRight: new Set(),
    barsBottom: new Set(),
  });
}

/** Fetch one puzzle by NYT puzzle id. Pass the `printDate` so the
 *  resulting `meta.id` falls back to a sensible string if the
 *  publication-date field is missing (rare but possible on legacy
 *  rows). */
export async function fetchNytPuzzleById(
  jar: NytCookieJar,
  puzzleId: number,
  printDate: string,
): Promise<{ state: PuzzleState; solution: (string[] | null)[][] }> {
  const url = `https://www.nytimes.com/svc/crosswords/v6/puzzle/${puzzleId}.json`;
  const resp = await nytGetJson<NytPuzzleResponse>(url, jar);
  const result = nytResponseToPuzzleState(resp, printDate);

  // If the response carries a raster overlay (theme circles on shaded
  // cells, and/or visual word-break bars), fetch + decode it and apply
  // every detected marking. The asset index is 1-based.
  const overlayIdx = resp.body[0]?.overlays?.beforeStart;
  if (overlayIdx && resp.assets && resp.assets[overlayIdx - 1]?.uri) {
    const uri = resp.assets[overlayIdx - 1]!.uri;
    const markings = await fetchOverlayMarkings(
      uri,
      jar,
      resp.body[0]!.dimensions.width,
      resp.body[0]!.dimensions.height,
    );
    applyOverlayMarkings(result.state.snapshot.cells, markings);
  }

  return result;
}

/** Convenience: list + first-Normal-result + by-id, for the one-shot
 *  "fetch the puzzle for this date" use case. Throws `NytNoPuzzleError`
 *  when nothing Normal is published for the requested date. */
export async function fetchNytPuzzleForDate(
  jar: NytCookieJar,
  date: string,
): Promise<{
  state: PuzzleState;
  solution: (string[] | null)[][];
  printDate: string;
  puzzleId: number;
}> {
  const list = await fetchNytPuzzleList(jar, date, date);
  const entry = list.find((r) => r.formatType === "Normal");
  if (!entry) {
    throw new NytNoPuzzleError(`No NYT crossword published for ${date}.`);
  }
  const { state, solution } = await fetchNytPuzzleById(jar, entry.puzzleId, entry.printDate);
  return { state, solution, printDate: entry.printDate, puzzleId: entry.puzzleId };
}

/** Parse a `users.nyt_cookie` column value into a jar. Accepts two
 *  shapes:
 *    - raw JSON object (back-compat — what we stored before the
 *      dump-nyt-cookies tool started emitting base64)
 *    - base64-of-JSON (the new tool's output)
 *  Detects by looking at the first non-whitespace character: `{`
 *  routes to JSON parsing; anything else is treated as base64. NULL
 *  / empty returns null (column unset). Throws `NytFetchError` with
 *  a user-targeted message on any failure so the UI can surface it
 *  inline. */
export function parseStoredCookieJar(raw: string | null | undefined): NytCookieJar | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  let jsonText: string;
  if (trimmed.startsWith("{")) {
    jsonText = trimmed;
  } else {
    // Buffer.from(s, "base64") silently ignores whitespace AND
    // silently ignores invalid characters, so a wholly bogus paste
    // can decode to a tiny garbage buffer that then fails JSON.parse.
    // That's fine — the next step's error message ("decoded base64
    // wasn't valid JSON") tells the user the right thing.
    let decoded: Buffer;
    try {
      decoded = Buffer.from(trimmed, "base64");
    } catch {
      throw new NytFetchError(
        "Couldn't decode the base64 string — make sure you copied the full output of dump-nyt-cookies.",
      );
    }
    if (decoded.length === 0) {
      throw new NytFetchError(
        "The pasted value looks empty after base64 decoding. Copy the full output of dump-nyt-cookies and try again.",
      );
    }
    jsonText = decoded.toString("utf8");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    throw new NytFetchError(
      "The cookie value didn't decode to valid JSON — make sure you copied the entire dump-nyt-cookies output.",
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new NytFetchError(
      "The cookie value must be a JSON object of {name: value} pairs.",
    );
  }
  const out: NytCookieJar = {};
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof v !== "string") {
      throw new NytFetchError(`Cookie value for '${k}' is not a string.`);
    }
    out[k] = v;
  }
  if (Object.keys(out).length === 0) {
    throw new NytFetchError("The decoded cookie jar is empty.");
  }
  return out;
}
