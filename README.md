# Crossplay

A collaborative crossword player. Upload a `.puz` file (or pick one from a curated set) and play it solo, or share the URL with a friend and play together. Includes a chat panel, reveal/check, pen vs. pencil, notes for cryptic puzzles, and a few of the small things that make solving with someone else nicer than solving alone.

## Running it (development)

Install once, then bring up the two dev servers in two terminals:

```sh
npm install
npm run dev:server    # API + WebSocket on :3001
npm run dev:client    # Vite on :5173 (proxies /api and /ws to :3001)
```

Open http://localhost:5173, pick a puzzle from the home page, or upload your own.

## Adding puzzles to the library

The home page's "Community puzzles" list reads from a SQLite table that's only writeable from the CLI — there's no HTTP upload path that adds to the library (uploads create ad-hoc *boards*, not library puzzles). To add a puzzle:

```sh
# Dev (uses packages/server/data/crossplay.db by default):
npx tsx packages/server/scripts/import-puzzle.ts path/to/puzzle.puz

# Production (point at the prod DB explicitly):
npx tsx packages/server/scripts/import-puzzle.ts \
  --db /home/admin/crossplay/data/crossplay.db \
  ~/nyt.puz
```

A few notes:

- Works on both `.puz` and `.ipuz` files; you can pass several at once.
- The puzzle's id (slug) is derived from the filename stem — `monday-themeless.puz` becomes `monday-themeless`. The script errors on slug collisions unless you pass `--force` to overwrite in place.
- DB resolution: `--db <path>` flag > `$DB_PATH` env var > the dev default (`packages/server/data/crossplay.db`).
- The script **requires the DB to already exist** and errors out if it doesn't. Unlike the server (which creates the file on first boot), the CLI refuses to auto-create — a typo in `--db` should fail loudly, not silently write into a phantom DB.
- Running it against a live server is safe — existing boards have their own copy of the puzzle's ipuz and aren't affected by re-imports or overwrites.

Example session:

```sh
$ npx tsx packages/server/scripts/import-puzzle.ts ~/puzzles/*.puz
WROTE /home/joel/puzzles/monday-themeless.puz -> monday-themeless
WROTE /home/joel/puzzles/sunday-times.puz -> sunday-times
FAIL  /home/joel/puzzles/duplicate.puz: puzzle 'duplicate' already exists (use --force to overwrite)

$ npx tsx packages/server/scripts/import-puzzle.ts --force ~/puzzles/duplicate.puz
REPLACED /home/joel/puzzles/duplicate.puz -> duplicate
```

## Sharing dev with a friend

To share with a friend without deploying anything, point a Cloudflare quick tunnel at the dev client:

```sh
cloudflared tunnel --url http://localhost:5173
```

WebSockets work through the tunnel; expect a small amount of extra latency that vanishes on a real deployment.

## Building & running for real

Build both packages, then start a single Node process that serves the API, the WebSocket, and the static client:

```sh
npm run build         # tsc for the server, vite for the client
npm start             # NODE_ENV=production node packages/server/dist/index.js
```

Defaults to port 3001 on 127.0.0.1. Override with `PORT` and `HOST`:

```sh
PORT=8080 HOST=0.0.0.0 npm start
```

A typical deployment is `nginx` → Node on a unix socket or local port. Routes:
- `/api/*` and `/ws/*` are the API and WebSocket; nginx should `proxy_pass` them with `proxy_http_version 1.1` and the standard `Upgrade` / `Connection` headers for WebSocket.
- Everything else is served from the built client (`packages/client/dist/`), with a SPA fallback so deep links like `/p/<id>` return `index.html`.

Optional env vars:
- `DB_PATH` — path to the SQLite file. Defaults to `packages/server/data/crossplay.db` (auto-created on first boot).
- `CLIENT_DIST` — path to the built client static files. Defaults to `packages/client/dist` relative to the server bundle.

## What it does

- Renders the puzzle grid and clue lists side-by-side. Click any cell or any clue to put the cursor there. Arrow keys move; clicking the same cell flips between across and down.
- Pen and pencil mode. Pencil entries render in italic grey and are skipped by Check.
- Reveal and Check, scoped by letter, word, or whole puzzle.
- Multiplayer over WebSocket. Anyone with the URL is in the same game; their letters appear in real time and briefly flash in their color so you can see what your friend just did.
- Live chat in a draggable, resizable panel. Messages prefixed with `!` show up bold and force-open the chat for everyone — useful for "going to grab lunch" announcements.
- Notes (the description field that comes with cryptic puzzles) viewable in a draggable panel. Opening it broadcasts to everyone, so you can spot when a partner consults the notes.
- A handful of keyboard shortcuts: `⌥R` / `⌥⇧R` reveal letter / word, `⌥C` / `⌥⇧C` check letter / word, `⌥N` notes, `⌥P` toggle pen/pencil, `/` open chat, `Esc` close chat, `Tab` / `⇧Tab` jump between clues.

## URL options

- `?name=Joel` — your display name in chat. Without it, you'll be assigned a random `Rando42` and it'll remember the name next time.

## Status

It's a personal project. Puzzles (library) and boards (playthroughs) live in SQLite and survive restarts. There's no auth; anyone with the URL can play and chat. Targets laptops; mobile and touch input aren't supported.

For a high-level walkthrough of how it's put together, see [`ARCHITECTURE.md`](./ARCHITECTURE.md).

## License

AGPL-3.0. See [`LICENSE`](./LICENSE).

If you run a modified copy on a server that anyone else can talk to, the AGPL requires you to make your modified source available to those users. The plan for that here is a small "source code" link on the home page pointing back to the public repo.
