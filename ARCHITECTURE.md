# Architecture

A walkthrough of how Crossplay is put together, aimed at someone who just wants the lay of the land.

## Three packages

Crossplay is an npm-workspaces monorepo with three packages:

- **`shared`** — TypeScript types only, no runtime code. The wire protocol (what flies between client and server) lives here so both sides agree on shape.
- **`server`** — Node + Fastify + Node's built-in `node:sqlite`. Owns the persistent library (puzzles), the persistent playthroughs (boards), and a WebSocket per board. Parses `.puz` via `puzjs` and `.ipuz` directly.
- **`client`** — React + Vite + TypeScript with CSS Modules. Renders the grid, handles input, and stays in sync with the server.

In production, the server also serves the built client static files, so it's a single Node process behind nginx. In development, the client is served by Vite and proxies API/WebSocket calls to the server on a separate port.

## Puzzles vs boards

The data model has two first-class entities, and confusing them creates real bugs.

- A **puzzle** is a *template* — an immutable canonical-form ipuz blob in the `puzzles` table, imported via the CLI script (`scripts/import-puzzle.ts`). Puzzles are never created or modified via HTTP. Think Word *templates*.
- A **board** is *one playthrough* — a row in the `boards` table that copies the puzzle's full ipuz blob and starts maintaining its own live snapshot, chat, and metadata. Boards are stamped from a puzzle (or from an ad-hoc file upload). Once stamped, a board is fully self-contained: re-importing the puzzle doesn't touch existing boards, and deleting the puzzle leaves boards playable. Think Word *documents*.

`boards.puzzle_id` records which puzzle slug a board came from, but it's a label, not a foreign key — it's nullable (ad-hoc uploads have no puzzle row at all) and may dangle (the puzzle was deleted later). Either way, everything play needs is on the board.

In user-facing copy these become "Community puzzles" and "Your games." In code, never use the word *game* — it's ambiguous between the two.

## How a keystroke travels

Probably the easiest way to understand the runtime is to follow one letter from finger to friend.

1. You press `K` in the grid. The client immediately renders `K` in your cell — no waiting on anyone. (More on this below.)
2. The client also sends a `fill` message over its WebSocket: "row, col, letter, your color."
3. The server validates (cell exists, isn't a block, letter looks sane), updates its in-memory copy of the board, bumps a version counter, and **broadcasts** a `cellUpdate` to every connected client on that board — including you.
4. Everyone applies the broadcast. You ignore your own update (you already have it). Your friend's client renders the `K` and briefly flashes it in your color so they can see what just changed.

Reveal, check, clear, chat, and "show notes" all follow the same shape: a small message goes up, server is the authority, the result fans out to everyone.

## Server-authoritative state, optimistic UI

The *server* is the source of truth for what's in the grid. But the *client* never waits for the server before showing your typing. Latency on a phone or shaky connection would be brutal otherwise.

The pattern: render locally, send to server, reconcile when the broadcast comes back. Because the server's response says exactly what each cell now contains (not a delta), reconciliation is trivial — just replace the cell with what the server says.

Reveal and check operations are server-authoritative too. They have to be: the solution lives only on the server (we don't ship it to the client), so only the server can know what "correct" means.

## Real-time via WebSocket

One WebSocket connection per browser tab per board, at `/ws/boards/:id`. The server holds the set of sockets per board and broadcasts to all of them on any change.

A 15-second server ping detects silently-dead connections (closed laptop lid, dead WiFi) within ~30 seconds. The client's reconnect logic retries with exponential backoff and re-announces presence on each reconnect.

There's no protocol versioning, no schema negotiation, no acks beyond the cell-update broadcasts. The wire is small and untyped past the JSON; the server validates each incoming message defensively.

## Persistence: SQLite, partial today

The server uses Node's built-in `node:sqlite` (synchronous, ships with Node 22.5+, stable in 24+). Two tables, no FK between them:

- `puzzles` — id, ipuz blob, denormalized title/author/width/height, timestamps. Curated by the operator via CLI.
- `boards` — id, nullable puzzle_id, ipuz blob (a copy at stamp time), denormalized title/author, JSON snapshot, JSON chat, timestamps.

Migrations are tracked via SQLite's built-in `PRAGMA user_version` — `db.ts` walks an append-only `migrations[]` array, runs anything past the current version inside its own transaction, and bumps the version. No migrations table.

What's persistent: the puzzle library, every board's existence + denormalized title/author, and the live snapshot + chat history. Mutations during play happen in-memory first; a per-board 15-second idle-debounced flush writes them back to the DB. The last socket leaving a board triggers a flush + cache eviction. SIGTERM/SIGINT drains every dirty cached board before exit. A hard crash within the 15-second window loses up to 15 seconds of play — by design (see `project_sqlite_sprint_plan.md`).

The in-memory cache (`store.ts`) keeps a board around as long as at least one socket is connected. It also retains the *initial* snapshot (parsed once from `boards.ipuz`) so the `clear` operation can restore to it without wiping author-prefilled cells.

## Some things we deliberately *didn't* use

- **No router library.** There are two routes (`/` and `/b/<id>`). A 25-line `routing.ts` handles them. If we ever grow to five-plus routes, swap in `wouter` (~2KB) before things tangle.
- **No Tailwind.** CSS Modules everywhere. The styling needs are modest enough that hand-written CSS reads cleaner than utility classes. (Some color values are quoted from Tailwind's palette because their picks are well-tuned, but the framework itself isn't a dependency.)
- **No state-management library.** React's `useState` plus a few `useRef`s for "I want the latest value without re-rendering" cases. The `Menu` component reads its action handlers from a ref that `PuzzleView` keeps current — that avoids re-rendering the menu on every cursor move while still letting clicks invoke the right things.
- **No build-time RPC layer.** The wire protocol is small enough to hand-write as TypeScript discriminated unions in `shared/`, validated on the server with simple type guards. tRPC or similar would add weight without saving much.

## Component tree

The client's React render tree at a glance. Solid edges are always-rendered children; dashed edges are conditional (route, load state, or panel-open flag). Hooks and pure helpers are omitted.

![Component tree](docs/components.png)

Source: [`docs/components.dot`](docs/components.dot) (regenerate with `dot -Tpng docs/components.dot -o docs/components.png`).

## Frontend choices worth knowing

- **The cell is sized in `font-size`, and everything inside uses `em`.** This means letters, numbers, and the revealed/wrong corner triangles all scale together when the cell scales — including when Safari does text-only zoom (which would otherwise grow the letter past the cell box).
- **Layout is a `height: 100vh` flex chain with `min-height: 0` on every flex item that should be allowed to shrink.** Removing those `min-height: 0`s breaks the layout in subtle ways; they're load-bearing.
- **The two big floating panels (chat and notes) use `react-rnd`** for drag and resize, with their position/size persisted to `localStorage` per panel. The Rect/load/save/clamp logic and the shared card/header/drag-handle CSS live in one place (`draggablePanel.ts` + `Panel.module.css`); each panel composes those bones and overrides the bits that differ.
- **Modifier keys bypass the keyboard handler.** `Cmd-L` focuses the address bar like usual; we don't try to capture browser shortcuts. `Option`/`Alt` + a letter is the namespace we use for in-app shortcuts (`⌥R` reveal, `⌥C` check, `⌥N` notes, `⌥P` toggle pen/pencil).

## What's deliberately out of scope

- Authentication or accounts. The trust model is "share the URL with a friend you trust." Boards are global, not per-user (yet).
- Mobile/touch input. Targets laptops only.
- Delete-a-board UI. Boards accumulate; cleanup affordance is a deferred feature.
- Rebus support and a solve timer — both flagged for future work but require their own design conversations. Rebus puzzles uploaded today are rejected at upload time with a clear message rather than partially loaded; the same policy applies to other `.ipuz` features outside the standard-crossword subset (circles, shading, bars, irregular grids).
