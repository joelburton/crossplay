/**
 * Reset a user's password from the command line. Admin-side tool —
 * there's no forgot-password flow in the app, so when someone forgets
 * theirs we run this against the prod DB.
 *
 *   npx tsx packages/server/scripts/set-password.ts --db <path> <username> <new-password>
 *
 * Username is matched case-insensitively against `handle_lower`.
 *
 * Exit codes:
 *   0 — password updated.
 *   2 — bad args, missing DB, or no such user.
 */

import { existsSync, statSync } from "node:fs";
import {
  MIN_PASSWORD_LENGTH,
  findUserByHandle,
  hashPassword,
  normalizeHandle,
} from "../src/auth.js";
import { DEFAULT_DB_PATH, closeDb, openDb } from "../src/db.js";

const argv = process.argv.slice(2);
let dbPath: string | undefined;
const positional: string[] = [];
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
      "Usage: tsx packages/server/scripts/set-password.ts --db <path> <username> <new-password>\n",
    );
    process.exit(0);
  } else {
    positional.push(a);
  }
}

if (positional.length !== 2) {
  process.stderr.write(
    "Usage: tsx packages/server/scripts/set-password.ts --db <path> <username> <new-password>\n",
  );
  process.exit(2);
}

const [username, password] = positional as [string, string];

if (password.length < MIN_PASSWORD_LENGTH) {
  process.stderr.write(
    `password must be at least ${MIN_PASSWORD_LENGTH} characters\n`,
  );
  process.exit(2);
}

const resolvedDbPath = dbPath ?? process.env.DB_PATH ?? DEFAULT_DB_PATH;
if (!existsSync(resolvedDbPath) || !statSync(resolvedDbPath).isFile()) {
  process.stderr.write(`DB file not found: ${resolvedDbPath}\n`);
  process.exit(2);
}

const db = openDb(resolvedDbPath);

const user = findUserByHandle(db, normalizeHandle(username));
if (!user) {
  process.stderr.write(`no such user: ${username}\n`);
  closeDb();
  process.exit(2);
}

db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(
  hashPassword(password),
  user.id,
);

process.stdout.write(`updated password for ${user.handle}\n`);
closeDb();
