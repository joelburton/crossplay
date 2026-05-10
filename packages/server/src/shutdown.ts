/**
 * Graceful shutdown: drain any dirty cached boards to SQLite, close the
 * Fastify app (which closes every open WebSocket), then close the DB
 * handle. Idempotent so SIGTERM + SIGINT firing in quick succession
 * (e.g. a panicked Ctrl-C) only runs once. Errors at each step are
 * logged but not propagated — a clean exit is more important than
 * surfacing a teardown error.
 *
 * Extracted from `index.ts` so unit tests can drive it without
 * spawning a real process or registering real signal handlers.
 */

import type { FastifyInstance } from "fastify";
import type { DatabaseSync } from "node:sqlite";
import { closeDb } from "./db.js";
import { flushAll } from "./store.js";

export type ShutdownDeps = {
  app: FastifyInstance;
  db: DatabaseSync;
  /** Injection seam for tests so `shutdown` doesn't actually terminate
   *  the test runner. Defaults to `process.exit`. */
  exit?: (code: number) => void;
};

export function createShutdown(deps: ShutdownDeps): (signal: NodeJS.Signals) => Promise<void> {
  const exit = deps.exit ?? ((code) => process.exit(code));
  let shuttingDown = false;
  return async function shutdown(signal: NodeJS.Signals) {
    if (shuttingDown) return;
    shuttingDown = true;
    deps.app.log.info({ signal }, "shutdown: flushing dirty boards");
    try {
      flushAll(deps.db);
    } catch (err) {
      deps.app.log.error({ err }, "shutdown: flushAll failed");
    }
    try {
      await deps.app.close();
    } catch (err) {
      deps.app.log.error({ err }, "shutdown: app.close failed");
    }
    try {
      closeDb();
    } catch (err) {
      deps.app.log.error({ err }, "shutdown: closeDb failed");
    }
    exit(0);
  };
}
