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
};

type NytPuzzleResponse = {
  body: NytPuzzleBody[];
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
  return nytResponseToPuzzleState(resp, printDate);
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

/** Parse a `users.nyt_cookie` column value into a jar. Tolerates the
 *  column being NULL / empty (returns null) and surfaces a clear
 *  message when the JSON is malformed. */
export function parseStoredCookieJar(raw: string | null | undefined): NytCookieJar | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new NytFetchError("stored NYT cookie is not valid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new NytFetchError("stored NYT cookie must be a JSON object of {name: value}");
  }
  const out: NytCookieJar = {};
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof v !== "string") {
      throw new NytFetchError(`stored NYT cookie value for '${k}' is not a string`);
    }
    out[k] = v;
  }
  return out;
}
