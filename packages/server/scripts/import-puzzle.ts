/**
 * Import .puz / .ipuz files into the puzzles table.
 *
 *   npx tsx packages/server/scripts/import-puzzle.ts <inputs...> \
 *     [--db <path>] [--force]
 *
 * Slug is the slugified filename stem. Collisions are an error unless
 * --force is passed (then the row is overwritten in place, preserving
 * created_at and bumping updated_at).
 *
 * DB resolution: --db <path> > $DB_PATH > the dev default. Unlike the
 * server (which creates its DB on first boot), this script REQUIRES the
 * DB file to already exist — a typo in the path should fail loudly
 * instead of silently writing into a phantom DB.
 */

import { existsSync, statSync } from "node:fs";
import { DEFAULT_DB_PATH, closeDb, openDb } from "../src/db.js";
import { importPuzzle } from "../src/importer.js";

const argv = process.argv.slice(2);
const inputs: string[] = [];
let force = false;
let dbPath: string | undefined;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]!;
  if (a === "--force" || a === "-f") {
    force = true;
  } else if (a === "--db") {
    const next = argv[++i];
    if (!next) {
      process.stderr.write("--db requires a path argument\n");
      process.exit(2);
    }
    dbPath = next;
  } else if (a.startsWith("--db=")) {
    dbPath = a.slice("--db=".length);
  } else if (a === "--help" || a === "-h") {
    process.stdout.write(
      "Usage: tsx packages/server/scripts/import-puzzle.ts <inputs...> [--db <path>] [--force]\n",
    );
    process.exit(0);
  } else if (a.startsWith("-")) {
    process.stderr.write(`unknown flag: ${a}\n`);
    process.exit(2);
  } else {
    inputs.push(a);
  }
}
if (inputs.length === 0) {
  process.stderr.write("no input files (pass one or more .puz/.ipuz paths)\n");
  process.exit(2);
}

// Resolve the DB path with the same precedence the rest of the
// toolchain uses, then require the file to exist — unlike `openDb`,
// which auto-creates for the server's first-boot case. Auto-creating
// here is a footgun: a typo in --db silently produces a phantom DB
// instead of failing, and the caller spends an hour wondering why
// their imported puzzle isn't showing up.
const resolvedDbPath = dbPath ?? process.env.DB_PATH ?? DEFAULT_DB_PATH;
if (!existsSync(resolvedDbPath) || !statSync(resolvedDbPath).isFile()) {
  process.stderr.write(
    `DB file not found: ${resolvedDbPath}\n` +
      `(import-puzzle won't create one — point --db / $DB_PATH at an existing DB,\n` +
      ` or start the server once to bootstrap it.)\n`,
  );
  process.exit(2);
}
const db = openDb(resolvedDbPath);
let failures = 0;
for (const input of inputs) {
  try {
    const { id, replaced } = importPuzzle({ db, path: input, force });
    process.stdout.write(`${replaced ? "REPLACED" : "WROTE"} ${input} -> ${id}\n`);
  } catch (err) {
    failures++;
    process.stderr.write(`FAIL ${input}: ${(err as Error).message}\n`);
  }
}
closeDb();
process.exit(failures > 0 ? 1 : 0);
