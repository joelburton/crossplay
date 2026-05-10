# Crossplay

A collaborative crossword player. Phase 1 (single-player, server-authoritative state) is complete. Multiplayer is the planned phase 2 — the wire protocol and store are already shaped for it.

## Stack

npm workspaces:

- `packages/shared` — wire types only (no runtime).
- `packages/server` — Fastify + `ws` (via `@fastify/websocket`) + puzjs. Node 20+, ESM.
- `packages/client` — Vite + React 18 + TypeScript, CSS Modules.

Tests run with vitest in both server and client.

## Run

```
npm install
npm run dev:server    # Fastify on :3001
npm run dev:client    # Vite on :5173 (proxies /api and /ws to :3001)
```

Both honor env vars:
- Server: `PORT` (bind port)
- Client: `PORT` (Vite bind), `API_PORT` (proxy target)
- Server: `CROSSPLAY_DEV_PUZ` (path to a .puz to load as id "dev")

```
npm run typecheck     # all packages
npm run test          # all packages (currently 60+ tests)
```

## Repo layout

```
packages/
  shared/src/index.ts              wire types: Cell, PuzzleMeta, GridSnapshot, ClientMessage, ServerMessage
  server/
    src/
      index.ts                     Fastify app; loads dev + sunday fixtures on startup
      puzzle.ts                    parses .puz buffer to PuzzleState + solution grid
      store.ts                     in-memory Map of puzzle id -> { state, solution, sockets }
      ws.ts                        WebSocket route + handlers + heartbeat
      types/puzjs.d.ts             ambient types for the untyped puzjs lib
    fixtures/
      a-very-moth-puzzle.puz       Joel's own puzzle, loaded as /p/dev
      sunday-sample.puz            21x21 synthetic, loaded as /p/sunday
    scripts/
      make-sunday-fixture.mjs      regenerate the sunday fixture
      set-puz-note.mjs             patch a .puz description in place
  client/
    src/
      App.tsx                      routing + load state + menu/notes dialog
      routing.ts                   hand-rolled SPA routing (NO react-router)
      api.ts                       REST helpers; throws HttpError(status)
      usePuzzleSocket.ts           ws connection with auto-reconnect
      cursor.ts                    pure cursor functions; tested
      puzzleActions.ts             type for the actions the menu invokes
      components/
        Board.tsx + Cell.tsx       grid render; sized via inline font-size in vw/vh
        ClueList.tsx               across/down lists; click to position
        Menu.tsx                   dropdown opened by clicking the "Crossplay" h1
        NoteDialog.tsx             modal for showing puzzle note
        PuzzleView.tsx             owns cursor + snapshot + ws; populates actionsRef
        UploadForm.tsx             multipart upload
```

## Wire protocol

**REST**
- `POST /puzzles` — multipart `.puz` upload, returns `{ puzzleId }`.
- `GET /puzzles/:id` — returns `PuzzleState` (meta + snapshot, NO solution).

**WebSocket** at `/puzzles/:id/ws`:
- Server -> client:
  - `{ type: "snapshot", snapshot: GridSnapshot }` on connect.
  - `{ type: "cellUpdate", row, col, cell, version }` per changed cell.
  - WebSocket `ping` frames every 15s; browser auto-pongs. Server terminates on missed pong (so silent disconnects detected within ~30s).
- Client -> server:
  - `{ type: "fill", row, col, letter, clientVersion }` — single cell.
  - `{ type: "reveal", scope: "letter"|"word"|"puzzle", row?, col?, dir? }`
  - `{ type: "check", scope: "letter"|"word"|"puzzle", row?, col?, dir? }`
  - `{ type: "clear" }` — wipe all fills + flags.

`cellUpdate` carries the **full new Cell**, not just a letter. The Cell may have `revealed` and/or `wrong` flags. Reveal/check operations bump version once per changed cell so the client's "newer version wins" check applies all updates from a batch broadcast.

## Architectural conventions worth knowing

- **Server is authoritative.** All grid mutations go through ws; client renders optimistically but the server's broadcast is the source of truth.
- **Optimistic typing is non-negotiable.** Letter input must render locally before any server roundtrip — see memory note `project_optimistic_typing.md`. Future features (cell locking, race-to-cell, check) must not block the typing hot path.
- **Solution stays server-side.** `GET /puzzles/:id` strips it; the server uses it for reveal/check.
- **Cursor advance after typing**: one cell, regardless of fill (skips blocks, stops at grid edge). Do NOT add "skip filled cells" logic — see memory note `project_advance_after_fill.md`.
- **Routing is hand-rolled** in `routing.ts`. No react-router. Two routes total: `/` and `/p/:id`. 404 on `/p/:id` redirects to `/`.
- **Menu actions** are populated into a ref by `PuzzleView` on every render; `App` reads the ref. This avoids re-rendering the menu on every cursor move.
- **WebSocket reconnect** lives in `usePuzzleSocket`: exponential backoff (500ms -> 30s cap), reset on successful open. Cleanup on unmount.
- **Layout** is height-100vh top-level flex. The chain of `min-height: 0` on flex children is load-bearing — don't add `min-height` defaults.
- **Cell sizing** uses inline `font-size: <calc>` and the cell's children use `em` units for everything (size, position, the triangle marker). This means it scales correctly under both Chrome page-zoom and Safari text-only-zoom.
- **Modifier keys** (Cmd/Ctrl/Alt) bypass the keystroke handler so the browser's normal shortcuts work. Option/Alt + letter is reserved for our shortcuts (using `e.code` to sidestep Mac dead-key remapping).

## Known dependency risk

- **puzjs** (the `.puz` parser) is unmaintained and ships ~19 vulnerable transitive deps. We use it only for local-dev parsing of trusted files for now. See memory note `project_puzjs_dependency.md` before exposing this app to untrusted uploads.

## .puz format gotchas

- ISO-8859-1 (Latin-1), not UTF-8. When generating or patching fixture strings, stay in ASCII or properly Latin-1-encoded bytes. UTF-8 multi-byte sequences (em-dashes, curly quotes) appear as `â`-prefixed garbage in the UI. See memory note `project_puz_latin1.md`.
- Header checksums are not validated by puzjs; `set-puz-note.mjs` patches in place without recomputing them. Other readers may complain.

## Out of scope so far

- Multiplayer: presence, names, conflict UX. (Wire protocol + per-puzzle socket set already exists; just needs UI.)
- Persistence: in-memory store; restart wipes all uploaded puzzles.
- Auth.
- Mobile/touch UI: this app targets laptops.
- Timer, completion detection, rebuses, .puz file uploads from untrusted sources.
