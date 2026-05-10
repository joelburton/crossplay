/**
 * Crossplay server entrypoint.
 *
 * Three concerns, in order:
 *   1. Open the SQLite handle and run any pending migrations (eager so
 *      a migration error fails boot, not first request).
 *   2. Boot Fastify with multipart + websocket, register the ws route
 *      at `/ws/boards/:id`. The in-memory store in `store.ts` lazy-
 *      loads board rows on first WS connect and writes them back on a
 *      15s idle debounce.
 *   3. Mount REST routes under `/api` and — only in production — serve
 *      the built client static files with an SPA fallback so deep links
 *      like `/b/<id>` resolve to `index.html`.
 *
 * In dev, Vite serves the client and proxies `/api` and `/ws` here
 * unchanged, so the same paths work in both modes.
 */

import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import multipart from "@fastify/multipart";
import staticPlugin from "@fastify/static";
import websocket from "@fastify/websocket";
import { closeDb, getDb } from "./db.js";
import { flushAll } from "./store.js";
import { registerHttpRoutes } from "./http.js";
import { registerWsRoutes } from "./ws.js";

const app = Fastify({ logger: true });

// Open the SQLite handle + run any pending migrations. Eager so a
// migration error fails boot instead of surfacing on first DB use.
const db = getDb();
app.log.info({ schemaVersion: (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version }, "sqlite ready");

await app.register(multipart, {
  limits: { fileSize: 5 * 1024 * 1024 },
});
await app.register(websocket);
registerWsRoutes(app, { db });

const here = dirname(fileURLToPath(import.meta.url));

// All HTTP API routes mounted under /api so they don't collide with
// SPA routes when the server also serves the built client.
await registerHttpRoutes(app, { db });

// Production-only: serve the built client and route SPA paths to index.html.
// Dev mode (Vite) doesn't need this — Vite serves the client itself and
// proxies /api + /ws to this server.
const isProd = process.env.NODE_ENV === "production";
const clientDist =
  process.env.CLIENT_DIST ?? resolve(here, "..", "..", "client", "dist");
if (isProd) {
  if (!existsSync(clientDist)) {
    app.log.error({ clientDist }, "CLIENT_DIST does not exist; run `npm run build` first");
    process.exit(1);
  }
  await app.register(staticPlugin, { root: clientDist });
  app.setNotFoundHandler((req, reply) => {
    // SPA fallback: GET (page navigation) or HEAD (link previews,
    // monitoring probes) for non-API/WS paths return index.html so the
    // client router handles the route. Everything else 404s.
    if (req.method !== "GET" && req.method !== "HEAD") {
      return reply.code(404).send({ error: "not found" });
    }
    if (req.url.startsWith("/api/") || req.url.startsWith("/ws/")) {
      return reply.code(404).send({ error: "not found" });
    }
    return reply.sendFile("index.html");
  });
  app.log.info({ clientDist }, "serving client static files");
}

// Drain dirty cached boards on graceful shutdown so a clean SIGTERM
// (e.g. nginx reload, manual ctrl-c in dev) doesn't lose play progress.
// We register the listener once; if both signals fire, the second is
// ignored. Errors during shutdown are logged but don't block exit —
// any unflushed work is already lost at that point.
let shuttingDown = false;
async function shutdown(signal: NodeJS.Signals) {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, "shutdown: flushing dirty boards");
  try {
    flushAll(db);
  } catch (err) {
    app.log.error({ err }, "shutdown: flushAll failed");
  }
  try {
    await app.close();
  } catch (err) {
    app.log.error({ err }, "shutdown: app.close failed");
  }
  try {
    closeDb();
  } catch (err) {
    app.log.error({ err }, "shutdown: closeDb failed");
  }
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

const port = Number(process.env.PORT ?? 3001);
const host = process.env.HOST ?? "127.0.0.1";
app.listen({ port, host }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
