# Wire protocol

All HTTP routes are mounted under `/api` and the WebSocket under `/ws`, so they don't collide with SPA paths when the production server also serves the built client. Client paths match — Vite proxies them through unchanged in dev.

## REST

- `GET /api/puzzles` — list of imported puzzles (`{id, title, author, width, height}` each, newest first). Public.
- `GET /api/boards` — **auth-required**. Boards the caller is a member of (`{id, puzzleId, title, author, copyright, updatedAt, fillPercent, members, isLive}`, newest first; `puzzleId` is null for ad-hoc uploads; `fillPercent` is null for untouched boards otherwise 0–100; `members` is the case-insensitively-sorted list of co-player handles (caller excluded); `isLive` is true iff at least one WS socket is currently connected). 401 without a session.
- `POST /api/boards` (JSON `{puzzleId}`) — **auth-required**. Soft dedup against `boards_users`: returns the caller's most-recently-updated board for that puzzle, or creates a new one. Returns `{boardId}`. 401 without a session; 404 if puzzle is unknown.
- `GET /api/boards/:id` — returns `PuzzleState` (meta + live snapshot, NO solution). Public — anyone with the URL can play (Posture A).
- `GET /api/boards/:id/ipuz` — download the board's current state as canonical ipuz. Public.
- `GET /api/boards/:id/solution` — returns `{solution: (string[] | null)[][]}` — per-cell answers (null for blocks, `[canonical, ...alternates]` for open cells). Used only by the print "Solution PDF" button. Public (same posture as the ipuz download, which also exposes the solution).
- `DELETE /api/boards/:id` — **auth-required**. Semantically "leave this board": removes the caller's `boards_users` row. If that was the last membership, hard-deletes the board (force-closes ws sockets, evicts cache) in the same transaction. Returns `{ok: true, deleted: boolean}`. 401 without a session; 404 when "no such board" or "not a member" (same observable).
- `POST /api/boards/:id/share` (JSON `{handle}`) — **auth-required + caller must be a member**. Resolves the handle case-insensitively, INSERT OR IGNOREs the membership row. Returns `{handle: <display-cased>, alreadyMember: boolean}` — `alreadyMember:true` covers both re-share and share-with-self. 401 / 403 / 404 (no such board OR no such user) / 400 (malformed handle).
- `POST /api/boards/upload` — **auth-required**. Multipart `.puz`/`.ipuz` upload. Creates a board with no puzzle row (`puzzle_id IS NULL`) and inserts the uploader's `boards_users` row in the same transaction. Returns `{boardId}`. 401 without a session.
- `POST /api/auth/register` (JSON `{handle, password, inviteCode}`) — public. 400 on bad input, 409 on handle collision; on success sets the `crossplay_session` cookie and returns `{user: <PublicUser>}`.
- `POST /api/auth/login` (JSON `{handle, password}`) — public. 401 generic on bad creds; on success sets the cookie and returns `{user}`.
- `POST /api/auth/logout` — clears the session row + cookie. 200 either way (idempotent).
- `GET /api/auth/me` — `{user}` if authed, 401 otherwise. Used by the client at mount to decide LandingPage vs HomePage.
- `GET /api/health` — `{ ok: true }`.

There is no `POST /api/puzzles` — puzzles are CLI-only, never created via HTTP. There are no admin routes — admins do their work via raw SQL (insert `invite_codes` rows, set `is_admin`, etc.).

## WebSocket

`/ws/boards/:id`. Server -> client:

- `snapshot { snapshot }` on connect.
- `cellUpdate { row, col, cell, version, senderColor? }` per changed cell.
- `chatMessage { name, color, text, ts }` broadcast.
- `notesShown` broadcast (no payload).
- `feedback { id, text, level, autoVanishMs? }` broadcast (e.g., joins, pencil-skip warnings).
- `cursorMoved { row, col, color, name }` — peer presence broadcast (not echoed to sender). Pure presence: not persisted, not version-stamped, not replayed on reconnect.
- `cursorLeft { color }` — broadcast on peer socket close so receivers drop that color's frame.
- `puzzleSolved` — broadcast on the false → true transition of "every fillable cell satisfies `fillMatchesSolution`".
- `scratchpadState { text, lockedBy: { name, color } | null }` — shared scratchpad state. Sent on connect and rebroadcast after every edit, takeover, or lock-release-on-disconnect. `lockedBy: null` means the scratchpad is unclaimed.
- WebSocket `ping` frames every 30s; browser auto-pongs. Server tolerates 3 consecutive missed pongs before terminating (silent-disconnect window ≈ 120s). The lenience is deliberate: macOS App Nap can throttle JS in backgrounded tabs, and even side-by-side visible tabs occasionally miss a pong. A lingering ghost socket for ~2 min is cheaper UX than spurious "X joined" feedbacks every minute. Both knobs (`HEARTBEAT_INTERVAL_MS`, `MISSED_PONG_TOLERANCE`) are overridable via `WsRouteOptions` so tests can drive the path in tens of ms.

Client -> server:

- `fill { row, col, letter, clientVersion, senderColor?, pencil? }` — single cell. `letter` is `null` (erase) or 1–`MAX_REBUS_LEN` uppercase letters (single letter or rebus answer).
- `reveal { scope: "letter"|"word"|"puzzle", row?, col?, dir?, senderColor? }`
- `check { scope: "letter"|"word"|"puzzle", row?, col?, dir? }`
- `mark { row, col, side, markType }` — word-break/hyphen mark on a cell edge. `markType: null` to clear.
- `clear` — wipe all fills + flags.
- `chat { name, color, text }`
- `showNotes` — opens the notes dialog for everyone in the room.
- `hello { name, color }` — sent on every ws open; powers the "X joined" feedback (debounced 5 min per name — long enough to swallow silent reconnects from proxy idle-close, browser throttling, or OS network blips).
- `cursorMoved { row, col, color, name }` — throttled to ~80ms on the client; outbound on every cursor change and on each ws open (so peers re-see us on reconnect).
- `scratchpadEdit { text }` — replace the shared scratchpad text. Server only honors edits from the socket that currently holds the lock; non-holder edits are silently dropped. `text` is capped at `SCRATCHPAD_MAX_LEN` (10 000 chars).
- `scratchpadTakeover { name, color }` — claim or steal the scratchpad lock. Always succeeds when the scratchpad is unclaimed or the caller already holds it; a steal from another holder is rejected with a warning feedback if their last edit was within 1 s (active-typing grace).

`cellUpdate` carries the **full new Cell**, not just a letter. Cell may have optional `revealed`, `wrong`, `pencil`, `circled`, `markRight`, `markBottom` flags. `circled` is pure presentation (author-defined theme marker), set at parse time and preserved across all mutations. Reveal/check operations bump the snapshot version once per changed cell so the client's "newer version wins" check applies all updates from a batch broadcast.
