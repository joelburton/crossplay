import { readFileSync } from "node:fs";
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

const fixtureDir = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
);
const DEFAULT_DEV_PUZ = resolve(fixtureDir, "a-very-moth-puzzle.puz");
const DEV_PUZ_PATH = process.env.CROSSPLAY_DEV_PUZ ?? DEFAULT_DEV_PUZ;
function loadFixture(id: string, path: string): void {
  try {
    const buf = readFileSync(path);
    const parsed = parsePuzBuffer(id, buf);
    putPuzzle(id, parsed);
    app.log.info({ path, id }, "loaded fixture puzzle");
  } catch (err) {
    app.log.warn({ err, path, id }, "no fixture puzzle loaded");
  }
}
loadFixture("dev", DEV_PUZ_PATH);
loadFixture("sunday", resolve(fixtureDir, "sunday-sample.puz"));

app.get("/health", async () => ({ ok: true }));

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
