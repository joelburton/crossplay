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
import type { GridSnapshot } from "@crossplay/shared";
import { parseIpuzBuffer } from "./ipuz.js";
import { computeFillPercent } from "./fillPercent.js";

const here = dirname(fileURLToPath(import.meta.url));
/** Path the server uses when DB_PATH is unset. Exported so the import
 *  CLI can show it in error messages and check its existence without
 *  re-deriving the path. */
export const DEFAULT_DB_PATH = resolve(here, "..", "data", "crossplay.db");

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
  {
    // Denormalize `copyright` onto both tables so the home page list
    // queries can show it without parsing each ipuz blob. New rows
    // populate it from meta.copyright at write time; this migration
    // backfills existing rows best-effort. Rows whose stored ipuz
    // can't be parsed (e.g. legacy boards stamped from a rebus puzzle
    // before the upload-time rejection landed) are skipped — their
    // copyright stays the column default ''.
    version: 2,
    up: (db) => {
      db.exec(`
        ALTER TABLE puzzles ADD COLUMN copyright TEXT NOT NULL DEFAULT '';
        ALTER TABLE boards  ADD COLUMN copyright TEXT NOT NULL DEFAULT '';
      `);
      for (const table of ["puzzles", "boards"] as const) {
        const rows = db
          .prepare(`SELECT id, ipuz FROM ${table}`)
          .all() as Array<{ id: string; ipuz: string }>;
        const upd = db.prepare(`UPDATE ${table} SET copyright = ? WHERE id = ?`);
        for (const row of rows) {
          try {
            const parsed = parseIpuzBuffer(row.id, Buffer.from(row.ipuz, "utf8"));
            const cr = parsed.state.meta.copyright;
            if (cr) upd.run(cr, row.id);
          } catch {
            // skip unparseable row
          }
        }
      }
    },
  },
  {
    // Denormalize a per-board "percent filled" so the home page list can
    // render NEW / N% / 100% without parsing each board's ipuz +
    // snapshot. NULL means "no player fills yet" (rendered as NEW); an
    // integer 0–100 means the live snapshot differs from the initial
    // one. The column is kept up to date by `flushBoard` — see store.ts.
    // This backfill is best-effort: unparseable rows are skipped and
    // stay at NULL (effectively "NEW"), which is fine since they're
    // already broken in other ways.
    version: 3,
    up: (db) => {
      db.exec(`ALTER TABLE boards ADD COLUMN fill_percent INTEGER`);
      const rows = db
        .prepare("SELECT id, ipuz, snapshot FROM boards")
        .all() as Array<{ id: string; ipuz: string; snapshot: string }>;
      const upd = db.prepare("UPDATE boards SET fill_percent = ? WHERE id = ?");
      for (const row of rows) {
        try {
          const parsed = parseIpuzBuffer(row.id, Buffer.from(row.ipuz, "utf8"));
          const live = JSON.parse(row.snapshot) as GridSnapshot;
          const pct = computeFillPercent(parsed.state.snapshot, live);
          if (pct !== null) upd.run(pct, row.id);
        } catch {
          // skip unparseable row
        }
      }
    },
  },
  {
    // Auth scaffolding (Phase 1 of the users feature). Three tables:
    //   - users: accounts with a unique handle (case-insensitive),
    //     scrypt password hash, optional email (admin out-of-band use
    //     only), is_admin boolean, the invite code they used at signup
    //     (forensic — delete-every-account-from-this-code recovery),
    //     and a reserved prefs JSON column for v2.
    //   - invite_codes: shared-secret words admins manage by hand.
    //     Stored lowercased; lookup is `code = LOWER(?)`.
    //   - sessions: server-side session table keyed by a random token.
    //     Sliding expiry; logout deletes the row.
    //
    // No board-side schema changes here — that's Phase 2 (owner_id) /
    // Phase 3 (boards_users). Phase 1 is purely additive; existing
    // anon board play is unaffected.
    version: 4,
    up: (db) => {
      db.exec(`
        CREATE TABLE users (
          id                INTEGER PRIMARY KEY AUTOINCREMENT,
          handle            TEXT NOT NULL,
          handle_lower      TEXT NOT NULL UNIQUE,
          password_hash     TEXT NOT NULL,
          email             TEXT,
          is_admin          INTEGER NOT NULL DEFAULT 0,
          invite_code_used  TEXT,
          prefs             TEXT,
          created_at        TEXT NOT NULL
        );

        CREATE TABLE invite_codes (
          code        TEXT PRIMARY KEY,
          label       TEXT,
          created_at  TEXT NOT NULL
        );

        CREATE TABLE sessions (
          id            TEXT PRIMARY KEY,
          user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          created_at    TEXT NOT NULL,
          last_seen_at  TEXT NOT NULL,
          expires_at    TEXT NOT NULL
        );

        CREATE INDEX sessions_user_id    ON sessions (user_id);
        CREATE INDEX sessions_expires_at ON sessions (expires_at);
      `);
    },
  },
  {
    // Phase 2 of the users feature: boards know their creator.
    //
    // owner_id is NULLABLE in the schema for two reasons:
    //   1. ON DELETE SET NULL: deleting a user shouldn't cascade-delete
    //      their boards if other people are also on them (Phase 3 will
    //      use the M2M for membership; Phase 2 is a stepping-stone
    //      where "owner" stands in for "the only member").
    //   2. Existing anon-era rows have no owner. Under Posture A we
    //      stop creating those, but pre-existing ones survive the
    //      migration unchanged.
    //
    // Application-level rule: every newly-created board carries an
    // owner_id. Routes that create boards now require auth (see
    // Phase 2 changes in http.ts).
    version: 5,
    up: (db) => {
      db.exec(`
        ALTER TABLE boards ADD COLUMN owner_id INTEGER
          REFERENCES users(id) ON DELETE SET NULL;
        CREATE INDEX boards_owner_id ON boards (owner_id);
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
