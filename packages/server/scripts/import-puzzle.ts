/**
 * Import .puz / .ipuz files into the puzzles table.
 *
 *   npx tsx packages/server/scripts/import-puzzle.ts <inputs...> [--force]
 *
 * Slug is the slugified filename stem. Collisions are an error unless
 * --force is passed (then the row is overwritten in place, preserving
 * created_at and bumping updated_at).
 *
 * The DB path follows the same DB_PATH env var the server uses, so
 * importing into the dev DB is just `npx tsx ... path/to/foo.puz`.
 */

import { closeDb, openDb } from "../src/db.js";
import { importPuzzle } from "../src/importer.js";

const argv = process.argv.slice(2);
const inputs: string[] = [];
let force = false;
for (const a of argv) {
  if (a === "--force" || a === "-f") {
    force = true;
  } else if (a === "--help" || a === "-h") {
    process.stdout.write(
      "Usage: tsx packages/server/scripts/import-puzzle.ts <inputs...> [--force]\n",
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

const db = openDb();
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
