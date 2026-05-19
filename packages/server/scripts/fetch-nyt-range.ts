/**
 * Download a date range of NYT daily crosswords and write them as
 * .ipuz files. Port of `get_range.py` from the nytxw_puz project,
 * targeting ipuz instead of binary .puz so we can use crossplay's
 * existing `writeIpuz` and avoid reimplementing puzjs's writer.
 *
 *   npx tsx packages/server/scripts/fetch-nyt-range.ts \
 *     <start-date> <end-date> <dest-folder>
 *
 * Dates are yyyy-mm-dd. "now" resolves to tomorrow (so a late-evening
 * run picks up the next day's puzzle once NYT publishes it ~10pm).
 *
 * Auth: reads `~/nytxw_puz.cookies.json`, the cookie cache the Python
 * tool already writes. Refresh it by running the Python tool once
 * (`python3 nyt.py <browser> <url> <out>`) when cookies expire.
 *
 * Output: one `YYYY-MM-DD.ipuz` per puzzle. Existing files are skipped
 * (idempotent like the Python). The files feed `import-puzzle.ts`
 * directly.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { writeIpuz } from "../src/ipuz.js";
import type { Cell, Clue, PuzzleState } from "@crossplay/shared";

// NYT cell-type codes (from nyt.py).
const NYT_BLOCK = 0;
const NYT_NORMAL = 1;
const NYT_CIRCLED = 2;
const NYT_GRAY = 3;
const NYT_INVISIBLE = 4;

const LIST_API =
  "https://www.nytimes.com/svc/crosswords/v3/puzzles.json" +
  "?publish_type=daily&sort_order=asc&sort_by=print_date" +
  "&date_start=START&date_end=END";

type CookieJar = Record<string, string>;

type ListResult = {
  results: Array<{
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

function usage(): never {
  console.error(
    [
      "",
      "Usage:",
      "  fetch-nyt-range.ts <start-date> <end-date> <dest-folder>",
      "",
      "Dates are yyyy-mm-dd. Use \"now\" for tomorrow's date.",
      "Reads cookies from ~/nytxw_puz.cookies.json (refresh via the Python tool).",
      "",
    ].join("\n"),
  );
  process.exit(1);
}

function cleanDate(val: string): string {
  if (val === "now") {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    return d.toISOString().slice(0, 10);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(val)) {
    console.error(`ERROR: bad date '${val}' (want yyyy-mm-dd or "now")`);
    process.exit(1);
  }
  return val;
}

function loadCookies(): CookieJar {
  const path = join(homedir(), "nytxw_puz.cookies.json");
  if (!existsSync(path)) {
    console.error(
      `ERROR: cookie cache not found at ${path}\n` +
        "Run the Python nytxw_puz tool once to populate it, then retry.",
    );
    process.exit(1);
  }
  return JSON.parse(readFileSync(path, "utf8")) as CookieJar;
}

function cookieHeader(jar: CookieJar): string {
  return Object.entries(jar)
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
}

async function getJson<T>(url: string, jar: CookieJar): Promise<T> {
  const resp = await fetch(url, {
    headers: {
      Cookie: cookieHeader(jar),
      // The NYT serves anti-bot challenge HTML to default UAs; a plain
      // browser UA + Referer is enough to pass through with valid auth.
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/125.0 Safari/537.36",
      Referer: "https://www.nytimes.com/crosswords",
      Accept: "application/json",
    },
  });
  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status} ${resp.statusText} for ${url}`);
  }
  const text = await resp.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(
      `Non-JSON response from ${url} (first 200 chars): ${text.slice(0, 200)}`,
    );
  }
}

/** Subset of nyt.py's HTML_TO_TEXT_RULES — covers everything we've
 *  seen in real clues. Latin-1 transliteration is skipped (ipuz is
 *  UTF-8). */
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
 *  grid that `writeIpuz` consumes. */
function toPuzzleState(
  resp: NytPuzzleResponse,
  printDate: string,
): { state: PuzzleState; solution: (string[] | null)[][] } {
  const body = resp.body[0];
  if (!body) throw new Error("missing body[0] in puzzle response");
  const width = body.dimensions.width;
  const height = body.dimensions.height;
  if (body.cells.length !== width * height) {
    throw new Error(
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

  const state: PuzzleState = {
    meta: {
      id: printDate,
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

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function main(): Promise<void> {
  if (process.argv.length !== 5) usage();
  const start = cleanDate(process.argv[2]!);
  const end = cleanDate(process.argv[3]!);
  const dest = process.argv[4]!;
  if (!existsSync(dest)) {
    console.log(`Creating ${dest}`);
    mkdirSync(dest, { recursive: true });
  }

  const cookies = loadCookies();
  const listUrl = LIST_API.replace("START", start).replace("END", end);
  const list = await getJson<ListResult>(listUrl, cookies);

  for (const cur of list.results) {
    if (cur.format_type !== "Normal") continue;
    const fn = join(dest, `${cur.print_date}.ipuz`);
    if (existsSync(fn)) {
      console.log(`'${fn}' already exists.`);
      continue;
    }
    const puzzleUrl = `https://www.nytimes.com/svc/crosswords/v6/puzzle/${cur.puzzle_id}.json`;
    const resp = await getJson<NytPuzzleResponse>(puzzleUrl, cookies);
    const { state, solution } = toPuzzleState(resp, cur.print_date);
    writeFileSync(fn, writeIpuz(state, solution));
    console.log(`Created '${fn}'`);
    // Don't torture the website (matches get_range.py).
    await sleep(1000);
  }
  console.log("All done.");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});
