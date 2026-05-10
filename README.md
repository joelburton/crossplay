# Crossplay

A collaborative crossword player. Upload a `.puz` file (or pick one from a curated set) and play it solo, or share the URL with a friend and play together. Includes a chat panel, reveal/check, pen vs. pencil, notes for cryptic puzzles, and a few of the small things that make solving with someone else nicer than solving alone.

## Running it

Install once, then bring up the two dev servers in two terminals:

```sh
npm install
npm run dev:server    # API + WebSocket on :3001
npm run dev:client    # Vite on :5173
```

Open http://localhost:5173, pick a puzzle from the home page, or upload your own.

To use a different folder of puzzles than the bundled fixtures:

```sh
GAME_DIR=/path/to/puzzles npm run dev:server
```

To share with a friend without deploying anything, point a Cloudflare quick tunnel at the dev client:

```sh
cloudflared tunnel --url http://localhost:5173
```

WebSockets work through the tunnel; expect a small amount of extra latency that vanishes on a real deployment.

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

It's a personal project. State is in-memory only — restart the server and uploads disappear (the library puzzles re-load from disk). There's no auth; anyone with the URL can play and chat. Targets laptops; mobile and touch input aren't supported.

For development notes, the architecture, the wire protocol, and the deferred-features list, see [`CLAUDE.md`](./CLAUDE.md).

## License

AGPL-3.0. See [`LICENSE`](./LICENSE).

If you run a modified copy on a server that anyone else can talk to, the AGPL requires you to make your modified source available to those users. The plan for that here is a small "source code" link on the home page pointing back to the public repo.
