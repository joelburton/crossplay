# User preferences — backlog

A running list of things users should eventually be able to view or
edit about their account or solving experience. Captured 2026-05-13.

**This is a backlog, not a spec.** Each entry is a candidate; the
shape of the implementation (and which to build first) is deferred
until there's a real reason to pick one up. The single source of
truth for the users feature itself is `docs/users-design.md`; this
doc just enumerates what the `users.prefs` JSON column might one day
hold, plus account-level surfaces that don't fit in `prefs`.

## Account / identity

- **Email** — column exists in `users`, optional, no UI. Today it's
  admin out-of-band use only. A "set / change email" field for the
  user wouldn't trigger any app behavior on its own (no verification,
  no transactional mail), but is a prerequisite for several items
  further down (notifications, password reset).
- **Password change** — currently admin-only via raw SQL. A normal
  "old password + new password" form, gated on the current session.
- **Account deletion** — currently admin-only via raw SQL. Schema
  already cascades cleanly (`sessions` and `boards_users` go away,
  owned boards have `owner_id` set NULL). UI question: hard delete
  vs. "deactivate" flag? Probably hard delete given the friends-of-
  friends trust model.
- **"Log out everywhere"** — the `sessions` table supports it (delete
  every row for the user). No UI yet. Useful after a shared-laptop
  session.
- **Handle rename** — `docs/users-design.md` says handles are
  immutable. Revisit only if a real reason emerges; the value is
  load-bearing in chat history, presence, and board membership
  display.
- **Display name** — the playful chat-pseudonym use case we removed
  on 2026-05-13 (Moth-the-account chatting as DrAnagram). If we want
  it back, the right shape is a `display_name` column on `users`,
  optional, surfaced as an override of the chat-side handle. Cleaner
  than the previous per-browser localStorage hack.

## Solving behavior

These all become entries in `users.prefs` (JSON). Defaults match
today's hardcoded behavior so existing users see no change.

- **Movement after fill** — currently NYT-style (stay in current
  word; stop at word boundary; do NOT skip filled cells, per
  memory `project_advance_after_fill.md`). Alternatives: skip-filled,
  skip-given, cross-block-into-next-word. Skip-filled is the most
  commonly requested.
- **Backspace behavior** — currently word-aware retreat (stays in
  current word). Some solvers prefer simpler "always step back one
  cell, period."
- **Auto-check while typing** — flag wrong letters live (red letter
  or strikethrough) vs. only on explicit Check. Some apps default
  this on; we default it off.
- **Confirm before destructive actions** — Clear board, Reveal
  puzzle, leaving a shared board. Currently no confirms (the home
  page's two-step delete is the closest precedent). Users who've
  been bitten ask for these.
- **Pen / pencil default** — currently always pen. Preference would
  pick the starting mode.
- **Collapse-rebuses default** — currently per-browser localStorage
  (`collapseRebus`). Migrate to per-user when prefs exist; keep
  localStorage as the anon fallback.
- **Tab navigation** — Tab → next clue (current) vs next *unfilled*
  clue. NYT does the latter by default.

## Presentation

- **Player color** — currently `colorForName(handle)` deterministic
  from the 8-color palette. User-pick (from the palette, or
  freeform) would feel personal. Watch out for the deterministic
  property breaking — peers currently agree on colors without
  coordination, which simplifies a lot of UI.
- **Theme** — light / dark / auto. Not built; would touch a lot of
  CSS but the structure is straightforward (custom-property tokens,
  swap at the root).
- **Clue font size** — accessibility win, especially on narrow
  viewports where the active-clue strip can be tight.
- **Show remote cursor frames** — some solvers find them
  distracting in collaborative play; option to hide.
- **Sound on solve** — the tada.mp3 jingle, on / off. Especially
  matters for solving in shared spaces (offices, libraries).
- **Welcome feedback gating** — the "Click heart for menu"
  one-shot is currently per-browser via
  `localStorage["seenWelcome"]`. Move to per-user once prefs
  exist (already noted as a TODO in CLAUDE.md).

## Input ergonomics

- **Backtick = Escape** — shipped 2026-05-13. Default-on; harmless
  unless a user actually wants to type backticks in chat. Gating
  this on a preference is a one-line change (the
  re-dispatch effect in `App.tsx` can be skipped if
  `prefs.backtickAsEscape === false`).

## Stays device-local (NOT per-user)

These are intentionally *not* candidates for `users.prefs`. They
describe the local environment, not the user's preference about
solving.

- **Chat panel position / size** — `crossplay.chatRect` in
  localStorage. Where the panel lives depends on which screen
  you're using, not who you are.
- **Note dialog position / size** — same story.
- **Anon chat name** — `crossplay.anonName`. Per-browser by
  definition; anons don't have accounts.

(The moth-and-Joel-share-a-laptop case where two people prefer
different panel positions on the same device is real but YAGNI; if
it ever matters, prefixing the localStorage key with the current
authed user id is a small, well-scoped fix.)

## Social / discovery (further out)

Not preferences strictly, but account-attached features that need
some of the same infrastructure.

- **Notifications** — when someone shares a board with you, when a
  shared board goes live with a peer in it. Needs email or push
  channel; not v1, and email path needs verification before it can
  be load-bearing.
- **"Recently played with" suggestions** — for the share dialog.
  Friends-of-friends scale; falls out of `boards_users` joins.

## Implementation notes (for whenever this gets picked up)

- The `users.prefs` column is already reserved as a JSON blob. A
  thin server-side helper `getUserPrefs(db, userId): Prefs` /
  `setUserPrefs(db, userId, partial: Partial<Prefs>)` is probably
  the right shape — parse on read, merge-and-write on update.
- The client should fetch prefs alongside `/api/auth/me` so the
  initial render has them. A second round-trip on every page load
  isn't worth it.
- For each pref, decide explicitly: is the localStorage version a
  fallback for anons (collapseRebus), a device-only setting (chat
  panel position), or fully replaced (welcome feedback)? Don't
  carry localStorage *and* prefs for the same setting unless
  there's a clear story for which wins.
- Preferences UI is its own screen / dialog — not the chat panel,
  not the menu. Probably linked from the `UserMenu` dropdown ("…
  · Preferences" next to "Log out").
