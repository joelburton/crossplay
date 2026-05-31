/**
 * Backfill `puzzles.content_hash` for rows imported before migration
 * v10 added the column. Run once after deploying; safe to re-run
 * (only touches rows where content_hash IS NULL).
 *
 *   npx tsx packages/server/scripts/backfill-puzzle-hashes.ts [--db <path>]
 *
 * Exit code:
 *   0 — every NULL row was hashed (or there were none).
 *   1 — at least one row was skipped (content collision with another
 *       row, or unparseable ipuz). Stderr lists each skip.
 *
 * Skips don't roll back the rows that did succeed — partial progress
 * sticks. A second run after fixing the underlying data picks up where
 * the first left off.
 */

import { existsSync, statSync } from "node:fs";
import { DEFAULT_DB_PATH, closeDb, openDb } from "../src/db.js";
import { parseIpuzBuffer } from "../src/ipuz.js";
import { puzzleContentHash } from "../src/importer.js";

const argv = process.argv.slice(2);
let dbPath: string | undefined;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]!;
  if (a === "--db") {
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
      "Usage: tsx packages/server/scripts/backfill-puzzle-hashes.ts [--db <path>]\n",
    );
    process.exit(0);
  } else {
    process.stderr.write(`unknown arg: ${a}\n`);
    process.exit(2);
  }
}

const resolvedDbPath = dbPath ?? process.env.DB_PATH ?? DEFAULT_DB_PATH;
if (!existsSync(resolvedDbPath) || !statSync(resolvedDbPath).isFile()) {
  process.stderr.write(`DB file not found: ${resolvedDbPath}\n`);
  process.exit(2);
}

const db = openDb(resolvedDbPath);

// Pre-load every hash already on disk so the script can detect both
// pre-existing collisions (two NULL rows that turn out to be the
// same puzzle) and clashes between a NULL row and an already-hashed
// row from a prior run.
const seen = new Map<string, string>();
for (const r of db
  .prepare("SELECT id, content_hash FROM puzzles WHERE content_hash IS NOT NULL")
  .all() as Array<{ id: string; content_hash: string }>) {
  seen.set(r.content_hash, r.id);
}

const rows = db
  .prepare("SELECT id, ipuz FROM puzzles WHERE content_hash IS NULL")
  .all() as Array<{ id: string; ipuz: string }>;

const upd = db.prepare("UPDATE puzzles SET content_hash = ? WHERE id = ?");
let updated = 0;
let skipped = 0;
for (const row of rows) {
  try {
    const parsed = parseIpuzBuffer(row.id, Buffer.from(row.ipuz, "utf8"));
    const hash = puzzleContentHash(parsed.state, parsed.solution);
    const dup = seen.get(hash);
    if (dup) {
      process.stderr.write(`SKIP ${row.id}: content matches existing '${dup}'\n`);
      skipped++;
      continue;
    }
    upd.run(hash, row.id);
    seen.set(hash, row.id);
    updated++;
  } catch (err) {
    process.stderr.write(`FAIL ${row.id}: ${(err as Error).message}\n`);
    skipped++;
  }
}

process.stdout.write(`updated=${updated} skipped=${skipped}\n`);
closeDb();
process.exit(skipped > 0 ? 1 : 0);
