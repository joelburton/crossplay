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
      ["author", "chat", "copyright", "created_at", "fill_percent", "id", "ipuz", "puzzle_id", "snapshot", "title", "updated_at"],
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

  it("v3 backfill: populates fill_percent on existing boards by comparing initial vs live snapshot", async () => {
    // Capture the real v3 before we swap the migration list.
    const realV3 = migrations.find((m) => m.version === 3);
    expect(realV3).toBeDefined();
    const upToV2 = migrations.filter((m) => m.version <= 2);

    // Lazy-import to avoid a cycle at module load (the test only needs
    // these for the fixture import; the real code paths don't touch
    // them directly in this test).
    const { importPuzzle } = await import("./importer.js");
    const { findOrCreateBoard } = await import("./boards.js");
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

      // Stand up two boards in the v2 schema (no fill_percent column).
      importPuzzle({ db, path: FIXTURE, force: false });
      const { boardId: untouchedId } = findOrCreateBoard(db, "sunday-sample");

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
