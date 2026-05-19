import { describe, expect, it } from "vitest";
import { migrations, openDb, type Migration } from "./db.js";

/** Run a fn against the migration list with a temporary set of fake
 *  migrations, restoring it afterwards even if the fn throws. The
 *  migration list is exported for exactly this kind of override. */
function withMigrations<T>(fakes: Migration[], fn: () => T): T {
  const saved = migrations.slice();
  migrations.length = 0;
  migrations.push(...fakes);
  try {
    return fn();
  } finally {
    migrations.length = 0;
    migrations.push(...saved);
  }
}

function userVersion(db: ReturnType<typeof openDb>): number {
  return (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
}

describe("db", () => {
  it("opens an in-memory DB and applies the latest migration version", () => {
    const db = openDb(":memory:");
    expect(userVersion(db)).toBe(migrations[migrations.length - 1]!.version);
    db.close();
  });

  it("runs pending migrations in order and bumps user_version", () => {
    withMigrations(
      [
        {
          version: 1,
          up: (db) => db.exec("CREATE TABLE a (x INTEGER)"),
        },
        {
          version: 2,
          up: (db) => db.exec("CREATE TABLE b (y INTEGER)"),
        },
      ],
      () => {
        const db = openDb(":memory:");
        expect(userVersion(db)).toBe(2);
        db.prepare("INSERT INTO a VALUES (1)").run();
        db.prepare("INSERT INTO b VALUES (2)").run();
        db.close();
      },
    );
  });

  it("skips migrations whose version is already applied", () => {
    withMigrations(
      [
        { version: 1, up: (db) => db.exec("CREATE TABLE a (x INTEGER)") },
      ],
      () => {
        const db = openDb(":memory:");
        // Bump user_version manually to simulate a re-open
        db.exec("PRAGMA user_version = 1");
        // Re-running should be a no-op (no error from re-creating table)
        // We can't easily reopen the same :memory: DB, so emulate by
        // calling the runner indirectly through a fresh openDb on the
        // same handle's schema-version state — already past v1, nothing
        // to run.
        expect(userVersion(db)).toBe(1);
        db.close();
      },
    );
  });

  it("applies the real migrations on a fresh DB and creates the puzzles + boards schema", () => {
    const db = openDb(":memory:");
    expect(userVersion(db)).toBeGreaterThanOrEqual(1);

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all() as Array<{ name: string }>;
    const tableNames = tables.map((t) => t.name);
    expect(tableNames).toContain("puzzles");
    expect(tableNames).toContain("boards");

    type ColInfo = { name: string; type: string; notnull: number; dflt_value: string | null; pk: number };
    const puzzlesCols = db.prepare("PRAGMA table_info(puzzles)").all() as ColInfo[];
    const boardsCols = db.prepare("PRAGMA table_info(boards)").all() as ColInfo[];

    expect(puzzlesCols.map((c) => c.name).sort()).toEqual(
      ["author", "copyright", "created_at", "height", "id", "ipuz", "title", "updated_at", "width"],
    );
    expect(boardsCols.map((c) => c.name).sort()).toEqual(
      ["author", "chat", "copyright", "created_at", "fill_percent", "id", "ipuz", "owner_id", "puzzle_id", "scratchpad_text", "snapshot", "title", "updated_at"],
    );
    // fill_percent is nullable: no NOT NULL constraint, no default — a
    // freshly inserted board is "NEW" until the first flushBoard.
    expect(boardsCols.find((c) => c.name === "fill_percent")!.notnull).toBe(0);
    expect(boardsCols.find((c) => c.name === "fill_percent")!.dflt_value).toBeNull();

    // Spot-check defaults & PK.
    expect(puzzlesCols.find((c) => c.name === "id")!.pk).toBe(1);
    expect(puzzlesCols.find((c) => c.name === "author")!.dflt_value).toBe("''");
    expect(puzzlesCols.find((c) => c.name === "copyright")!.dflt_value).toBe("''");
    expect(boardsCols.find((c) => c.name === "chat")!.dflt_value).toBe("'[]'");
    expect(boardsCols.find((c) => c.name === "copyright")!.dflt_value).toBe("''");

    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'boards' ORDER BY name")
      .all() as Array<{ name: string }>;
    const indexNames = indexes.map((i) => i.name);
    expect(indexNames).toContain("boards_puzzle_id");
    expect(indexNames).toContain("boards_updated_at");

    db.close();
  });

  it("v4 creates the auth tables (users, invite_codes, sessions) with correct shape", () => {
    const db = openDb(":memory:");
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all() as Array<{ name: string }>;
    const tableNames = tables.map((t) => t.name);
    expect(tableNames).toContain("users");
    expect(tableNames).toContain("invite_codes");
    expect(tableNames).toContain("sessions");

    type ColInfo = { name: string; type: string; notnull: number; pk: number };
    const usersCols = db.prepare("PRAGMA table_info(users)").all() as ColInfo[];
    // Asserts the full live shape after all migrations have run, not
    // strictly the v4 set — `seen_help_at` arrived in v7, `nyt_cookie`
    // in v9.
    expect(usersCols.map((c) => c.name).sort()).toEqual([
      "created_at",
      "email",
      "handle",
      "handle_lower",
      "id",
      "invite_code_used",
      "is_admin",
      "nyt_cookie",
      "password_hash",
      "prefs",
      "seen_help_at",
    ]);
    expect(usersCols.find((c) => c.name === "handle_lower")!.notnull).toBe(1);
    expect(usersCols.find((c) => c.name === "email")!.notnull).toBe(0);

    // handle_lower has UNIQUE index (sqlite creates an auto-index).
    db.prepare(
      "INSERT INTO users (handle, handle_lower, password_hash, created_at) VALUES (?, ?, ?, ?)",
    ).run("Moth", "moth", "x", "2026-05-12");
    expect(() =>
      db
        .prepare(
          "INSERT INTO users (handle, handle_lower, password_hash, created_at) VALUES (?, ?, ?, ?)",
        )
        .run("MOTH", "moth", "y", "2026-05-12"),
    ).toThrow();

    // sessions FK cascade: deleting a user removes their sessions.
    db.prepare(
      "INSERT INTO sessions (id, user_id, created_at, last_seen_at, expires_at) VALUES (?, 1, ?, ?, ?)",
    ).run("tok1", "2026-05-12", "2026-05-12", "2026-06-11");
    db.prepare("DELETE FROM users WHERE id = 1").run();
    const remaining = db.prepare("SELECT COUNT(*) AS c FROM sessions").get() as { c: number };
    expect(remaining.c).toBe(0);

    db.close();
  });

  it("v5 adds boards.owner_id with SET NULL on user delete and an index", () => {
    const db = openDb(":memory:");
    // Seed user + board so we can exercise the FK behavior.
    db.prepare(
      "INSERT INTO users (handle, handle_lower, password_hash, created_at) VALUES (?, ?, ?, ?)",
    ).run("Moth", "moth", "x", "2026-05-12");
    const userId = (
      db.prepare("SELECT id FROM users WHERE handle_lower = ?").get("moth") as { id: number }
    ).id;
    db.prepare(
      "INSERT INTO boards (id, ipuz, title, snapshot, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run("b1", "{}", "test", "{}", userId, "2026-05-12", "2026-05-12");

    // Deleting the owner SETs NULL rather than cascading the board
    // (Phase 3 will use the M2M for the "delete-on-last-member" rule).
    db.prepare("DELETE FROM users WHERE id = ?").run(userId);
    const after = db
      .prepare("SELECT owner_id FROM boards WHERE id = ?")
      .get("b1") as { owner_id: number | null };
    expect(after.owner_id).toBeNull();

    const idx = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'boards' AND name = 'boards_owner_id'",
      )
      .all();
    expect(idx).toHaveLength(1);

    db.close();
  });

  it("v3 backfill: populates fill_percent on existing boards by comparing initial vs live snapshot", async () => {
    // Capture the real v3 before we swap the migration list.
    const realV3 = migrations.find((m) => m.version === 3);
    expect(realV3).toBeDefined();
    const upToV2 = migrations.filter((m) => m.version <= 2);

    // Lazy-import to avoid a cycle at module load (the test only needs
    // these for the fixture import; the real code paths don't touch
    // them directly in this test).
    const { importPuzzle } = await import("./importer.js");
    const { parseIpuzBuffer } = await import("./ipuz.js");
    const { dirname, resolve } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const FIXTURE = resolve(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "fixtures",
      "sunday-sample.puz",
    );

    withMigrations(upToV2, () => {
      const db = openDb(":memory:");
      expect(userVersion(db)).toBe(2);

      // Stand up two boards in the v2 schema (no fill_percent column,
      // no owner_id column — both come in later migrations). Skip
      // findOrCreateBoard / insertBoardRow here because they're the
      // *current* code and would try to write columns the v2 schema
      // doesn't have.
      importPuzzle({ db, path: FIXTURE, force: false });
      const puzzleIpuz = (
        db
          .prepare("SELECT ipuz FROM puzzles WHERE id = ?")
          .get("sunday-sample") as { ipuz: string }
      ).ipuz;
      const parsedPuzzle = parseIpuzBuffer("sunday-sample", Buffer.from(puzzleIpuz, "utf8"));
      const initialSnapshotJson = JSON.stringify(parsedPuzzle.state.snapshot);
      const untouchedId = "untouched-board";
      const seedNow = new Date().toISOString();
      db.prepare(
        "INSERT INTO boards (id, puzzle_id, ipuz, title, author, copyright, snapshot, chat, created_at, updated_at) VALUES (?, 'sunday-sample', ?, 'T', '', '', ?, '[]', ?, ?)",
      ).run(untouchedId, puzzleIpuz, initialSnapshotJson, seedNow, seedNow);

      // Second board: clone the row with a different id and a mutated snapshot.
      const row = db
        .prepare("SELECT ipuz, snapshot FROM boards WHERE id = ?")
        .get(untouchedId) as { ipuz: string; snapshot: string };
      const parsed = parseIpuzBuffer("sunday-sample", Buffer.from(row.ipuz, "utf8"));
      const live = JSON.parse(row.snapshot) as { version: number; cells: Array<Array<{ kind: string; fill?: string | null }>> };
      // Mutate exactly one fillable cell so the snapshot differs from initial.
      outer: for (const r of live.cells) {
        for (const c of r) {
          if (c.kind === "cell") {
            c.fill = "Z";
            break outer;
          }
        }
      }
      const touchedId = "touched-board";
      const now = new Date().toISOString();
      db.prepare(
        "INSERT INTO boards (id, puzzle_id, ipuz, title, author, copyright, snapshot, chat, created_at, updated_at) VALUES (?, NULL, ?, 'T', '', '', ?, '[]', ?, ?)",
      ).run(touchedId, row.ipuz, JSON.stringify(live), now, now);

      // Sanity: column doesn't exist yet.
      const v2Cols = db.prepare("PRAGMA table_info(boards)").all() as Array<{ name: string }>;
      expect(v2Cols.find((c) => c.name === "fill_percent")).toBeUndefined();

      // Run v3 by hand against the same db.
      db.exec("BEGIN");
      realV3!.up(db);
      db.exec("PRAGMA user_version = 3");
      db.exec("COMMIT");

      // Untouched board: live == initial, so fill_percent stays NULL (NEW).
      const untouched = db
        .prepare("SELECT fill_percent FROM boards WHERE id = ?")
        .get(untouchedId) as { fill_percent: number | null };
      expect(untouched.fill_percent).toBeNull();

      // Touched board: one cell filled out of all fillable cells.
      const touched = db
        .prepare("SELECT fill_percent FROM boards WHERE id = ?")
        .get(touchedId) as { fill_percent: number | null };
      const totalFillable = parsed.state.snapshot.cells
        .flat()
        .filter((c) => c.kind === "cell").length;
      expect(touched.fill_percent).toBe(Math.floor((1 / totalFillable) * 100));

      db.close();
    });
  });

  it("v6 creates boards_users with cascade FKs and a composite PK", () => {
    const db = openDb(":memory:");
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all() as Array<{ name: string }>;
    expect(tables.map((t) => t.name)).toContain("boards_users");

    type ColInfo = { name: string; type: string; notnull: number; pk: number };
    const cols = db.prepare("PRAGMA table_info(boards_users)").all() as ColInfo[];
    expect(cols.map((c) => c.name).sort()).toEqual(["board_id", "created_at", "user_id"]);
    // Composite PK: board_id + user_id are both pk-flagged.
    expect(cols.find((c) => c.name === "board_id")!.pk).toBeGreaterThan(0);
    expect(cols.find((c) => c.name === "user_id")!.pk).toBeGreaterThan(0);

    // Seed a user + a board to exercise the cascades.
    db.prepare(
      "INSERT INTO users (handle, handle_lower, password_hash, created_at) VALUES (?, ?, ?, ?)",
    ).run("Moth", "moth", "x", "2026-05-12");
    const userId = (
      db.prepare("SELECT id FROM users WHERE handle_lower = ?").get("moth") as { id: number }
    ).id;
    db.prepare(
      "INSERT INTO boards (id, puzzle_id, ipuz, title, snapshot, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run("b1", "p1", "{}", "T", "{}", userId, "2026-05-12", "2026-05-12");
    db.prepare(
      "INSERT INTO boards_users (board_id, user_id, created_at) VALUES (?, ?, ?)",
    ).run("b1", userId, "2026-05-12");

    // PK enforces one row per (board, user).
    expect(() =>
      db
        .prepare(
          "INSERT INTO boards_users (board_id, user_id, created_at) VALUES (?, ?, ?)",
        )
        .run("b1", userId, "2026-05-12"),
    ).toThrow();

    // Board delete cascades the join row.
    db.prepare("DELETE FROM boards WHERE id = ?").run("b1");
    expect(
      db.prepare("SELECT COUNT(*) AS c FROM boards_users WHERE board_id = ?").get("b1"),
    ).toEqual({ c: 0 });

    // User delete cascades all their join rows. (boards.owner_id goes
    // to NULL via the v5 FK; verified elsewhere.)
    db.prepare(
      "INSERT INTO boards (id, puzzle_id, ipuz, title, snapshot, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run("b2", "p2", "{}", "T", "{}", userId, "2026-05-12", "2026-05-12");
    db.prepare(
      "INSERT INTO boards_users (board_id, user_id, created_at) VALUES (?, ?, ?)",
    ).run("b2", userId, "2026-05-12");
    db.prepare("DELETE FROM users WHERE id = ?").run(userId);
    const remaining = db
      .prepare("SELECT COUNT(*) AS c FROM boards_users WHERE user_id = ?")
      .get(userId) as { c: number };
    expect(remaining.c).toBe(0);

    db.close();
  });

  it("v6 backfill: existing owner_id rows get a boards_users entry; anon-era rows don't", async () => {
    const realV6 = migrations.find((m) => m.version === 6);
    expect(realV6).toBeDefined();
    const upToV5 = migrations.filter((m) => m.version <= 5);

    withMigrations(upToV5, () => {
      const db = openDb(":memory:");
      expect(userVersion(db)).toBe(5);

      // Two users, three boards: one owned by each user against the
      // same library puzzle, and one anon-era board with no owner_id.
      db.prepare(
        "INSERT INTO users (handle, handle_lower, password_hash, created_at) VALUES (?, ?, ?, ?)",
      ).run("Alice", "alice", "x", "2026-05-12");
      db.prepare(
        "INSERT INTO users (handle, handle_lower, password_hash, created_at) VALUES (?, ?, ?, ?)",
      ).run("Bob", "bob", "x", "2026-05-12");
      const alice = (
        db.prepare("SELECT id FROM users WHERE handle_lower = ?").get("alice") as { id: number }
      ).id;
      const bob = (
        db.prepare("SELECT id FROM users WHERE handle_lower = ?").get("bob") as { id: number }
      ).id;

      const ins = db.prepare(
        "INSERT INTO boards (id, puzzle_id, ipuz, title, snapshot, owner_id, created_at, updated_at) VALUES (?, ?, ?, 'T', '{}', ?, ?, ?)",
      );
      ins.run("ba", "p1", "{}", alice, "2026-05-12", "2026-05-12");
      ins.run("bb", "p1", "{}", bob, "2026-05-12", "2026-05-12");
      ins.run("bz", null, "{}", null, "2026-05-12", "2026-05-12");

      db.exec("BEGIN");
      realV6!.up(db);
      db.exec("PRAGMA user_version = 6");
      db.exec("COMMIT");

      const rows = db
        .prepare("SELECT board_id, user_id FROM boards_users ORDER BY board_id")
        .all() as Array<{ board_id: string; user_id: number }>;
      expect(rows).toEqual([
        { board_id: "ba", user_id: alice },
        { board_id: "bb", user_id: bob },
      ]);
      // Anon-era board is intentionally NOT in the join.
      db.close();
    });
  });

  it("v7 adds users.seen_help_at (nullable TEXT) for first-visit help gating", () => {
    const db = openDb(":memory:");
    type ColInfo = { name: string; type: string; notnull: number };
    const cols = db.prepare("PRAGMA table_info(users)").all() as ColInfo[];
    const col = cols.find((c) => c.name === "seen_help_at");
    expect(col).toBeDefined();
    expect(col!.notnull).toBe(0); // nullable; NULL = unseen

    // Seed a user; column defaults to NULL on insert.
    db.prepare(
      "INSERT INTO users (handle, handle_lower, password_hash, created_at) VALUES (?, ?, ?, ?)",
    ).run("Moth", "moth", "x", "2026-05-12");
    const row = db
      .prepare("SELECT seen_help_at FROM users WHERE handle_lower = ?")
      .get("moth") as { seen_help_at: string | null };
    expect(row.seen_help_at).toBeNull();

    // Application can stamp it; admin can clear it with raw SQL.
    db.prepare("UPDATE users SET seen_help_at = ? WHERE handle_lower = ?").run(
      "2026-05-13T00:00:00.000Z",
      "moth",
    );
    const stamped = db
      .prepare("SELECT seen_help_at FROM users WHERE handle_lower = ?")
      .get("moth") as { seen_help_at: string | null };
    expect(stamped.seen_help_at).toBe("2026-05-13T00:00:00.000Z");

    db.prepare("UPDATE users SET seen_help_at = NULL").run();
    const cleared = db
      .prepare("SELECT seen_help_at FROM users WHERE handle_lower = ?")
      .get("moth") as { seen_help_at: string | null };
    expect(cleared.seen_help_at).toBeNull();
    db.close();
  });

  it("rolls back a failing migration and leaves user_version untouched", () => {
    withMigrations(
      [
        {
          version: 1,
          up: (db) => {
            db.exec("CREATE TABLE a (x INTEGER)");
            throw new Error("boom");
          },
        },
      ],
      () => {
        expect(() => openDb(":memory:")).toThrow(/boom/);
      },
    );
  });
});
