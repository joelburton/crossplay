/**
 * SQLite handle + migration runner. Uses Node's built-in node:sqlite
 * (synchronous, ships with Node 22.5+, stable in 24+) so we avoid the
 * native-compile pain of better-sqlite3.
 *
 * Migrations are tracked via SQLite's built-in PRAGMA user_version — no
 * separate migrations table. On startup we read the current version and
 * run any later migrations in order, each wrapped in its own transaction.
 *
 * The handle is a process-wide singleton; tests that need an isolated DB
 * can call `openDb(":memory:")` directly.
 */

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const DEFAULT_DB_PATH = resolve(here, "..", "data", "crossplay.db");

export interface Migration {
  version: number;
  up: (db: DatabaseSync) => void;
}

/** Ordered list of migrations. Append-only. Version numbers must be
 *  strictly increasing and never reused. */
export const migrations: Migration[] = [
  {
    // `puzzles` are CLI-curated library templates; `boards` are
    // playthroughs. A board may have been stamped from a puzzle
    // (`puzzle_id` = the slug, possibly dangling if later deleted) or
    // come from an ad-hoc upload with no puzzle row at all
    // (`puzzle_id` IS NULL). The puzzles table is never load-bearing
    // for play — every board carries its own ipuz blob and is fully
    // self-contained.
    version: 1,
    up: (db) => {
      db.exec(`
        CREATE TABLE puzzles (
          id          TEXT PRIMARY KEY,
          ipuz        TEXT NOT NULL,
          title       TEXT NOT NULL,
          author      TEXT NOT NULL DEFAULT '',
          width       INTEGER NOT NULL,
          height      INTEGER NOT NULL,
          created_at  TEXT NOT NULL,
          updated_at  TEXT NOT NULL
        );

        CREATE TABLE boards (
          id          TEXT PRIMARY KEY,
          puzzle_id   TEXT,
          ipuz        TEXT NOT NULL,
          title       TEXT NOT NULL,
          author      TEXT NOT NULL DEFAULT '',
          snapshot    TEXT NOT NULL,
          chat        TEXT NOT NULL DEFAULT '[]',
          created_at  TEXT NOT NULL,
          updated_at  TEXT NOT NULL
        );

        CREATE INDEX boards_puzzle_id  ON boards (puzzle_id);
        CREATE INDEX boards_updated_at ON boards (updated_at DESC);
      `);
    },
  },
];

export function openDb(path: string = process.env.DB_PATH ?? DEFAULT_DB_PATH): DatabaseSync {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA foreign_keys = ON");
  runMigrations(db);
  return db;
}

function runMigrations(db: DatabaseSync): void {
  const row = db.prepare("PRAGMA user_version").get() as { user_version: number };
  const current = row.user_version;
  const pending = migrations
    .filter((m) => m.version > current)
    .sort((a, b) => a.version - b.version);
  for (const m of pending) {
    db.exec("BEGIN");
    try {
      m.up(db);
      db.exec(`PRAGMA user_version = ${m.version}`);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }
}

let _db: DatabaseSync | undefined;

export function getDb(): DatabaseSync {
  if (!_db) _db = openDb();
  return _db;
}

export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = undefined;
  }
}
