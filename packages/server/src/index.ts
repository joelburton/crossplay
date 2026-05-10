import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import multipart from "@fastify/multipart";
import websocket from "@fastify/websocket";
import { parsePuzBuffer } from "./puzzle.js";
import { getPuzzle, putPuzzle } from "./store.js";
import { registerWsRoutes } from "./ws.js";

const app = Fastify({ logger: true });

await app.register(multipart, {
  limits: { fileSize: 5 * 1024 * 1024 },
});
await app.register(websocket);
registerWsRoutes(app);

// Load a library of pre-existing .puz files from GAME_DIR (if set).
// Defaults to the fixture dir so a fresh checkout has playable games.
const fixtureDir = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
);
const GAME_DIR = process.env.GAME_DIR ?? fixtureDir;

function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "game"
  );
}

function loadGame(id: string, path: string): boolean {
  try {
    const buf = readFileSync(path);
    const parsed = parsePuzBuffer(id, buf);
    putPuzzle(id, parsed);
    return true;
  } catch (err) {
    app.log.warn({ err, path, id }, "skipping unreadable puzzle");
    return false;
  }
}

const libraryIds: string[] = [];
try {
  const entries = readdirSync(GAME_DIR);
  const seen = new Set<string>();
  for (const entry of entries) {
    if (!entry.toLowerCase().endsWith(".puz")) continue;
    let id = slugify(entry.replace(/\.puz$/i, ""));
    // ensure uniqueness if two filenames slugify the same
    let n = 2;
    while (seen.has(id)) {
      id = `${slugify(entry.replace(/\.puz$/i, ""))}-${n++}`;
    }
    seen.add(id);
    if (loadGame(id, resolve(GAME_DIR, entry))) libraryIds.push(id);
  }
  app.log.info({ path: GAME_DIR, count: libraryIds.length }, "loaded game library");
} catch (err) {
  app.log.warn({ err, path: GAME_DIR }, "could not read GAME_DIR");
}

app.get("/health", async () => ({ ok: true }));

app.get("/games", async () => {
  const out: Array<{
    id: string;
    title: string;
    author: string;
    width: number;
    height: number;
  }> = [];
  for (const id of libraryIds) {
    const entry = getPuzzle(id);
    if (!entry) continue;
    const m = entry.state.meta;
    out.push({
      id,
      title: m.title,
      author: m.author,
      width: m.width,
      height: m.height,
    });
  }
  return out;
});

app.post("/puzzles", async (req, reply) => {
  const file = await req.file();
  if (!file) {
    return reply.code(400).send({ error: "missing file" });
  }
  const buffer = await file.toBuffer();
  const id = randomUUID();
  try {
    const parsed = parsePuzBuffer(id, buffer);
    putPuzzle(id, parsed);
    return { puzzleId: id };
  } catch (err) {
    req.log.error({ err }, "failed to parse .puz");
    return reply.code(400).send({ error: "invalid .puz file" });
  }
});

app.get<{ Params: { id: string } }>("/puzzles/:id", async (req, reply) => {
  const entry = getPuzzle(req.params.id);
  if (!entry) return reply.code(404).send({ error: "not found" });
  return entry.state;
});

const port = Number(process.env.PORT ?? 3001);
app.listen({ port, host: "127.0.0.1" }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
