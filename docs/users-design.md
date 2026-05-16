# Users feature — design notes

Captured 2026-05-11 from the planning thread. Conceptual model is
settled; concrete schema + routes + MVP slicing are below.

## Goals and non-goals

**Goals**

- Friends + friends-of-friends scale. Joel runs the server; others can
  self-host. Software is OSS.
- Self-hosters are comfortable with SQL — admin tasks (add a user to
  the puzzle library curators, etc.) can be raw `UPDATE`s.
- Accounts unlock features (share with named friends, sticky "My
  games" list) — they never gate access to any URL that worked before.
- No email or SMS dependency. Invite-code-only registration.
- "Just text the URL" remains a first-class way to play together
  (ad-hoc sharing).

**Terminology**

Two things in this design have historically both been called
"invite," and the conflation bites. Locked-in vocabulary:

- **Invite code** — the shared-secret word a new user types at signup
  to be allowed to register. Stored in the `invite_codes` table,
  managed by the admin via SQL.
- **Share** — the act of adding another existing user to your board's
  membership so it shows up in their My Games. No separate table;
  it's a direct insert into `boards_users`.

Never say "invite Moth to a board" — say "share a board with Moth."
Reserve "invite" for signup.

**Non-goals**

- Email verification, password reset flows, OAuth, SSO.
- Worldwide trust model. Invite codes are shared secrets; if one
  leaks, the admin deletes it and that's the end of it.
- Per-board ACLs / kick / report. Trust is established socially via
  invite codes; everyone in your circle is welcome.

## Identity model

- **Account handle** (single field): unique-ish (case-insensitive on
  lookup, case-preserved for display), light validation (no weird
  punctuation), immutable after signup. Used for login, used for
  share-with-handle, used as the default chat display name.
- **Chat display name**: orthogonal to the account handle. Persists in
  `localStorage` like today. Defaults to the account handle when
  logged in; defaults to `Rando<NN>` for anons. Moth-the-account can
  call herself "DrAnagram" in chat for a cryptic without changing her
  account handle, and Joel's "share with moth" still resolves to her
  account.
- **Email**: nullable, no verification. Strictly for the admin's
  out-of-band use ("upgrading my server," "house party"); never used
  by the app itself.
- **Password**: hashed with **scrypt** (built-in `node:crypto`, no
  native dep; see `auth.ts`). Stored as a self-describing
  `scrypt$N$r$p$salt$key` string so future parameter bumps or a
  migration to a different KDF can coexist with old hashes. Minimum
  length 6, no other rules. No reset flow — admin sets a new hash
  via SQL if needed.

## Invite codes (registration)

- Simple shared-secret words (human-readable). Stored in an
  `invite_codes` table; admin manages by hand-editing the table.
- Many-use, deleteable. Case-insensitive lookup. Storing the code
  used on each `users` row (`invite_code_used`) gives forensic
  recovery if one over-shares ("delete every account that used
  `cryptic-night`").
- No fancy tokens, no expiration logic (yet). If you want a code to
  stop working, delete the row.

## Anon play — "URL only" (Posture A)

We picked the simpler of the two postures: anon = "follow a board URL
and play that board." Nothing more.

- **`/b/<id>` works without auth.** Same as today. Anons play, chat as
  `Rando<NN>`, full read/write on the board. UUID unguessability is
  the access barrier.
- **`/` (home page) requires login.** Visiting it while signed out
  shows a public landing page with login + signup forms, not the
  full home. Library browsing, "My games," and upload are all
  account-only.
- **`boards.owner_id` is NOT NULL.** Every board has a creator.
  Cascade-on-empty applies uniformly — no "anon detritus"
  accumulation.
- **No `localStorage.recent` list.** No batch board-lookup API.
  Logged-in users have one discoverability surface (`boards_users`),
  period.
- **No anon uploads.** Upload is a logged-in action; no per-stranger
  size policy needed.

### Public landing page (anon `/`)

Same hero (site icon + "Crossplay" wordmark) as the logged-in home,
then:

- **Log in** form: handle + password.
- **Sign up** form: handle + password + invite code.
- A short paragraph: *"Crossplay is invite-only. Ask a friend for a
  code, or wait for one of them to invite you to a game. If a friend
  has sent you a board URL, just open it — you don't need an account
  to play."*

Two practical small touches:

- **Return-after-login.** If a logged-out user lands on a page that
  requires auth (the future home, settings, etc.), the redirect to
  `/` carries the original path as `?return=...`. Post-login, we
  send them back. Avoids the "I clicked a deep link and now I'm lost"
  feeling.
- **Visiting `/` from a board.** If a user was just playing on
  `/b/<id>` and clicks the site icon → `/`, the landing page can
  show a small line like *"Keep playing →"* with the board's URL,
  so they don't lose their place. (Minor; probably v2.)

### Why this is the right shape for this audience

The site is for friends + friends-of-friends. A friend-of-friend
intrigued enough to use the site beyond one game is exactly the
person who'd ask for an invite code. The "text someone a URL, they
play" use case is fully preserved — Joel's mom can play the URL Joel
sends her without ever signing up. Library browse + upload behind
auth is a fine constraint at this scale.

### Optional: "Create an account" nudge for anon co-solvers

When an anon plays a board (especially after solving it), the
SolvedDialog or a small banner can offer:

> Enjoyed this? Get an account to keep your games.

Clicking the CTA goes to `/register`. We could pre-fill the invite
code from `users.invite_code_used` of the board's `owner_id` — so
the person Joel shared with gets a one-click signup with Joel's
code already filled.

Small caveat on pre-fill: that means **anyone who joins one of
Joel's boards via URL learns his invite code** (it's in the signup
URL the page sends them to). If Joel uses one well-trusted code for
close circles, that's a leak vector. Mitigations:
- Joel uses a separate "casual sharing" invite code for boards he
  expects to share by URL, deletes if it ever escapes.
- Or: omit the pre-fill; the CTA goes to a blank `/register` and the
  host tells the guest the code separately.

The CTA is **not required for v1**. It's a nice ergonomic touch we
can add when sharing is otherwise working.

## Logged-in play

- Click library puzzle P1: soft dedup. If the user is already a
  member of any P1 board, navigate to the most-recently-updated one.
  Otherwise create a new board with `owner_id = me`, member = me.
- The dedup is intentionally a default, not an invariant — a user
  *can* have multiple boards for the same puzzle (e.g. "the solo
  one I started, and the one I'm playing with Moth"). A future
  FE affordance ("you already have a board for this — keep it, or
  start fresh?") makes the second-board case a deliberate click.
- Upload a file: creates a new board (no `puzzle_id`), member = me.
- Boards are still URL-accessible to anyone; sharing only affects
  discoverability on the home page.

## Sharing — board membership as M2M

- A board has an `owner_id` (who created it) AND a `boards_users`
  join table listing every account with the board in their "My games."
  Owner is auto-inserted into the join on board creation.
- Sharing "with moth" inserts `(moth, board)` into the join — that's
  the whole mechanism. Moth's home page shows the board because she's
  a row, not because of any access check.
- **No accept step.** The audience is friends-and-friends-of-friends;
  the invite-code gate at registration already established trust.
  Sharing is direct insertion into the M2M table, no "pending
  share" state, no separate `shares` table. Spam isn't a concern at
  this scale, and Moth can just delete the row (which removes the
  board from her My Games and cascade-deletes it if no one else is
  on it) if she doesn't want it.
- Joining via ad-hoc URL (no formal share) does NOT add a join row.
  The visitor can play; if they're a logged-in user, the board does
  NOT enter their My Games. (Anons have no My Games at all under
  Posture A.) If they want it persistent on their home page, the
  owner needs to formally share.
- "Delete from My Games" = remove your own row from the join table.
  Triggered cascade: when the join table for a board hits zero rows,
  the board row itself is removed. (Force-close any open WS sockets +
  evict the cache entry — same machinery the existing `DELETE
  /api/boards/:id` route uses.)
- Sharing is idempotent: re-sharing with an existing member is a
  no-op. Sharing with yourself is a no-op.
- **No share-collision handling.** A user may end up a member of two
  boards for the same puzzle (e.g. their own solo board plus one
  Joel shared with them). That's allowed. The home-page list sorts
  by `updated_at` so the active one rises naturally; co-player
  handles distinguish the rows visually.

## "Your games" row contents

Each row in My Games shows:

- Title / author / copyright (today).
- Friendly relative date + fill-percent / NEW (today).
- **Co-player handles** — every member of the board's `boards_users`
  join other than yourself. Falls out of the same query that
  produces the list; no extra round-trip.
- **Live indicator** — a small "● live" badge or colored dot when at
  least one socket is currently in the board's WS room. Derived from
  the in-memory `StoredBoard.sockets` set on the server; surfaced on
  the boards-list endpoint as either `liveCount` or `isLive`.

The live indicator is what makes "joel is playing right now, come
join" naturally visible without needing a notification system: Moth
opens her home page, sees the cryptic she's a member of with a live
badge, clicks. For v1, "live as of when you loaded the home page" is
enough — adding real-time updates is a later concern.

## Uniqueness

The schema has exactly one uniqueness rule: the composite primary key
`(boards_users.board_id, user_id)` — i.e. a user is a member of a
board at most once. That's it.

Earlier drafts of this doc also enforced "at most one board per
library puzzle per user" via a denormalized `puzzle_id` column and a
partial unique index, with a share-collision dance to handle Moth
already having a P1 board when Joel shared his with her. That's been
dropped: multiple boards per (user, puzzle) are allowed. The library
click defaults to the most-recently-updated existing board (soft
dedup), and a future FE affordance ("start fresh?") makes a second
board on a deliberate click. The share route becomes a plain
idempotent insert with no collision branch.

## What URL-followers see

If a **logged-in user** follows an ad-hoc URL to someone else's
board, they play normally but the board does NOT enter their My
Games. They'd have to bookmark the URL or ask the owner to formally
share. (Side observation: the WS connection still carries their
session cookie, so the server could surface "Joel joined" in chat or
auto-share with them. Not v1.)

If an **anon** follows a URL, they play normally with no persistent
discoverability. The URL is their only handle on the board.

## Roles

Single `is_admin` boolean on `users`. Admins curate the puzzle library
(however that ends up working — form, zip upload, whatever). Anyone
can create / share / upload / play.

## Session model

- Cookie-based session. HTTP-only, `Secure` in prod, `SameSite=Lax`.
- Sliding lifetime, 30–90 days. Refresh on each authenticated request.
- Server-side session table (`id`, `user_id`, `expires_at`,
  `last_seen_at`). Logout deletes the row.
- "Log out everywhere" = delete all rows for the user. Future feature.

## Schema

Append-only migrations per the existing pattern in `db.ts`. Three new
tables plus a column on `boards`.

### `users`

```
id              INTEGER PRIMARY KEY
handle          TEXT NOT NULL                         -- case-preserved
handle_lower    TEXT NOT NULL UNIQUE                  -- LOWER(handle); used for lookups
password_hash   TEXT NOT NULL                         -- scrypt; see "Password storage" below
email           TEXT                                  -- nullable; admin-only out-of-band use
is_admin        INTEGER NOT NULL DEFAULT 0            -- 0/1 boolean
invite_code_used TEXT                                 -- the invite code used at signup, or NULL for admin-seeded
prefs           TEXT                                  -- JSON blob; reserved for v2
created_at      TEXT NOT NULL                         -- ISO timestamp
```

Generated column `handle_lower` keeps the case-insensitive uniqueness
clean (a `UNIQUE INDEX ON LOWER(handle)` would work too — same effect).

### `invite_codes`

```
code            TEXT PRIMARY KEY                      -- stored lowercased
label           TEXT                                  -- admin's note about who this is for
created_at      TEXT NOT NULL
```

Admins insert / delete rows by hand. Lookup is `WHERE code =
LOWER(?)`. No expiration column for v1 — admins delete when needed.

### `sessions`

```
id              TEXT PRIMARY KEY                      -- random token, set as cookie value
user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE
created_at      TEXT NOT NULL
last_seen_at    TEXT NOT NULL                         -- bumped on each authed request (sliding)
expires_at      TEXT NOT NULL                         -- last_seen + 30d
```

Token is a random 32-byte hex string. Cookie is HTTP-only, `Secure`
in prod, `SameSite=Lax`, path `/`.

### `boards` — column additions

```
owner_id        INTEGER REFERENCES users(id) ON DELETE SET NULL
```

Nullable in the schema (so user-delete cascades cleanly), but the
application enforces "always set on creation" — there's no code path
that creates a board without a logged-in user under Posture A. Old
anon-era boards have NULL `owner_id`; they're invisible to the
boards-list endpoint (no `boards_users` rows) and admin can drop
them via SQL.

### `boards_users`

```
board_id        TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE
user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE
created_at      TEXT NOT NULL
PRIMARY KEY (board_id, user_id)
```

Indexed on `user_id` for the per-user list query. No denormalized
`puzzle_id`, no partial unique index — the "click a library puzzle"
flow does a soft dedup against `boards.puzzle_id` via the join (see
the Uniqueness section), and multiple boards per (user, puzzle) are
allowed by design.

### Cascade behaviors

- User delete: cascade drops their sessions and their `boards_users`
  rows. Owned boards have `owner_id` set NULL. The board persists
  for any remaining members; if they were the only member, the
  `boards_users` cascade leaves it orphaned (no members), which the
  application-level "delete-on-empty" trigger then cleans up (or
  admin sweeps).
- Board delete: cascades `boards_users`.

### "Delete-on-empty" enforcement

Two options:

1. **DB trigger** that deletes the `boards` row when `boards_users`
   for that board hits zero. Robust, declarative.
2. **Application-level** check in the "leave board" route — after
   removing the row, if the count is zero, delete the board.

I'd go with option 2 for v1 because we want to coordinate with the WS
layer anyway (force-close open sockets, evict the cache entry), and
those are application concerns. A trigger that just deletes the row
would leave the in-memory state inconsistent.

## Password storage

`crypto.scryptSync` from Node's standard library. No new dependency.
Format stored in `password_hash`:

```
scrypt$<N>$<r>$<p>$<salt-hex>$<key-hex>
```

Parameters: N=16384, r=8, p=1 (the OWASP defaults). Verify by deriving
with the stored salt + params and constant-time-comparing keys.

Argon2id would be marginally stronger but requires a native dep. Not
worth it at this scale; scrypt is fine.

## Routes

### Public (no auth required)

- `POST /api/auth/register` — `{ handle, password, inviteCode }` →
  200 + session cookie. Validates the code (case-insensitive),
  creates user, creates session. 400 on bad input, 409 on handle
  collision.
- `POST /api/auth/login` — `{ handle, password }` → 200 + cookie.
  401 on bad credentials. (We could rate-limit if needed; not v1.)
- `POST /api/auth/logout` — clears the session row + cookie. 200 even
  if not authed (idempotent).
- `GET /api/auth/me` — `{ user }` if authed, 401 otherwise.
- `GET /api/boards/:id` — current. Works for anyone with the URL.
- `GET /api/boards/:id/ipuz` — current.
- `GET /api/puzzles` — current. The library is a public catalog; no
  reason to gate it. (Anons can't see it because the home page is
  account-gated, but the endpoint itself is fine open.)
- `GET /api/health` — current.
- `WS /ws/boards/:id` — current. Carries session cookie if present;
  unauthenticated joins still work (anon URL play).

### Auth-required

- `GET /api/boards` — boards in the current user's `boards_users`.
  Response per board: `{id, puzzleId, title, author, copyright,
  updatedAt, fillPercent, members: [handle], isLive: bool}`.
- `POST /api/boards` — `{ puzzleId }`. Dedup-or-create: if the user
  already has a board for `puzzleId`, return its id; otherwise
  create a new board with `owner_id = me`, insert `(me, board,
  puzzle_id)` into `boards_users`. Returns `{boardId}`.
- `POST /api/boards/upload` — current, but stamps `owner_id` and
  inserts the join row.
- `DELETE /api/boards/:id` — semantically "leave this board."
  Removes my `boards_users` row. If that was the last member, also
  deletes the board (cascades the rest, force-closes WS sockets,
  evicts cache).
- `POST /api/boards/:id/share` — `{ handle }`. Resolves handle
  (case-insensitive), validates the user exists, inserts the join
  row. Idempotent: already-a-member and share-with-self are both
  silent no-ops. No collision handling — the new member is now a
  member of *this* board; whatever other boards they may already
  have for the same puzzle stay theirs.

### Admin (future)

No admin routes for v1. Library curation stays CLI-only.

## Auth middleware

A Fastify `preHandler` hook on the API routes:

1. Read session cookie.
2. Look up `sessions` row by id; check `expires_at > now`.
3. If valid: load user, attach to `req.user`, bump `last_seen_at` and
   `expires_at` (sliding window, +30d from now).
4. If invalid / missing: `req.user = null`.

Auth-required routes have a second hook that 401s if `req.user` is
null. A small decorator keeps the route declarations clean.

## Client changes

### New components

- `LandingPage.tsx` — public `/`. Hero, login form, register form,
  the "you can ask for an invite" paragraph.
- `LoginForm.tsx`, `RegisterForm.tsx` — submit to the auth routes,
  redirect on success (honoring `?return=`).
- `ShareDialog.tsx` — opens from the board menu, takes a handle,
  reports success / unknown-handle / already-a-member.

### Modified components

- `App.tsx` — routes by authed status. `/` → `HomePage` if authed,
  `LandingPage` otherwise. `/b/:id` always works.
- `HomePage.tsx` — drops "Recent" / localStorage paths. Renders
  co-player handles and the live badge per row.
- `Menu.tsx` — adds "Log out" when authed.
- `chatIdentity.ts` — when authed, defaults the chat name to the
  account handle. localStorage rename still overrides.
- `api.ts` — adds auth functions, 401 handling (redirect to landing).
- `useBoardSocket.ts` — no change; the session cookie rides along
  natively on the WS upgrade.

## Phase plan

Each phase ships independently.

**Phase 1 — Auth scaffolding** (no other behavior changes)
- Migrations for `users`, `invite_codes`, `sessions`.
- `POST /api/auth/register|login|logout`, `GET /api/auth/me`.
- Session middleware.
- `LandingPage`, login/register forms, return-after-login.
- Menu gets a "Log out" item.
- chatIdentity defaults to handle when authed.
- Existing anon board play still works unchanged.

**Phase 2 — Ownership** (boards know who created them)
- Add `owner_id` to `boards` (nullable in schema).
- Library-click and upload routes stamp `owner_id` when authed.
- `GET /api/boards` filters to "boards I own" (interim until Phase 3
  adds the join).
- Home page's "My Games" reflects the filter.

**Phase 3 — Sharing** (the M2M layer)
- Add `boards_users` table (composite PK only — no denormalized
  puzzle_id, no partial unique index).
- Owner is auto-inserted into the join on board creation.
- `POST /api/boards/:id/share` (idempotent, no collision branch).
- `DELETE /api/boards/:id` rewired to "leave + cascade-on-empty."
- Library-click does a soft dedup against the join: returns the
  most-recently-updated existing board, or creates a new one.
- Boards-list returns `members` + `isLive`.
- `ShareDialog` UI.

**Phase 4 — Ergonomics** (after the core works)
- "Play another with X" button on `SolvedDialog`.
- Optional anon "Get an account" CTA on solved dialog for anon
  URL-followers.
- Per-row "shared with you" freshness hint (rows where the user's
  `boards_users.created_at` is within 24h of now).

**Phase 5+** — preferences, admin UI, real-time share notifications.

## Testing strategy

- Auth routes: unit tests for register validation (invite-code
  case-insensitivity, handle uniqueness, password min-length),
  login success/failure, session expiry.
- Session middleware: tests that authed routes 401 without a valid
  session, that sliding expiry bumps `last_seen_at`.
- Sharing: tests for the M2M cases — share-with-self, share-with
  -already-member, share-collision (solo and multi-user variants),
  leave-board cascading.
- Live badge: unit-testable via the in-memory `StoredBoard.sockets`
  size; integration tests can drive a WS connect and assert the
  flag flips.
- Migrations: each new migration tested for idempotency and for
  correct schema state after running.

## Out-of-scope for v1

- Real-time "moth just shared a board with you" popovers. Pull on
  home-page mount is fine; we can add a persistent app-level WS later.
- Username renames.
- Per-user labels on boards ("Sunday cryptic with Joel"). Schema is
  designed to support it (label column on `boards_users`), just not
  built.
- Admin UI. Admin uses SQL.
- Account deletion flow. Admin uses SQL.
