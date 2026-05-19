/**
 * Download a date range of NYT daily crosswords and write them as
 * .ipuz files. Thin CLI wrapper around `src/nyt.ts` — fetch + convert
 * lives there; this script just handles argv, the cookie cache file,
 * and write-to-disk loop.
 *
 *   npx tsx packages/server/scripts/fetch-nyt-range.ts \
 *     <start-date> <end-date> <dest-folder>
 *
 * Dates are yyyy-mm-dd. "now" resolves to tomorrow (so a late-evening
 * run picks up the next day's puzzle once NYT publishes it ~10pm).
 *
 * Auth: reads `~/nytxw_puz.cookies.json`, the cookie cache the Python
 * nytxw_puz tool already writes. Refresh by running the Python tool
 * once when cookies expire.
 *
 * Output: one `YYYY-MM-DD.ipuz` per puzzle. Existing files are skipped
 * (idempotent like get_range.py). The files feed `import-puzzle.ts`
 * directly.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { writeIpuz } from "../src/ipuz.js";
import {
  type NytCookieJar,
  fetchNytPuzzleById,
  fetchNytPuzzleList,
} from "../src/nyt.js";

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

function loadCookies(): NytCookieJar {
  const path = join(homedir(), "nytxw_puz.cookies.json");
  if (!existsSync(path)) {
    console.error(
      `ERROR: cookie cache not found at ${path}\n` +
        "Run the Python nytxw_puz tool once to populate it, then retry.",
    );
    process.exit(1);
  }
  return JSON.parse(readFileSync(path, "utf8")) as NytCookieJar;
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
  const list = await fetchNytPuzzleList(cookies, start, end);

  for (const cur of list) {
    if (cur.formatType !== "Normal") continue;
    const fn = join(dest, `${cur.printDate}.ipuz`);
    if (existsSync(fn)) {
      console.log(`'${fn}' already exists.`);
      continue;
    }
    const { state, solution } = await fetchNytPuzzleById(
      cookies,
      cur.puzzleId,
      cur.printDate,
    );
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
