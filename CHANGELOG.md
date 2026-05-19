# Changelog

## v0.9.0 — 2026-05-19 (pre-release)

First public pre-release. Single- and multi-player play of `.puz` and
`.ipuz` crosswords is working end-to-end, with accounts, friend-to-friend
sharing, and the collaboration surfaces (live cell sync, presence,
chat, shared notes, shared scratchpad).

Marked pre-release because the trust model is friends-of-friends (no
email verification, no password reset, no account-deletion UI — admin
handles those by SQL) and the puzzle dependency (`puzjs`) is
unmaintained, so this is not yet appropriate to expose to untrusted
input.

### Highlights

- **Crossword play.** `.puz` and `.ipuz` input formats, both pivoting
  through a canonical ipuz form. Rebus (up to 8 chars), Schrödinger
  cells, circled / shaded / given cells, irregular grids.
- **Multiplayer.** Real-time fills, cursors, presence; per-board chat
  (now persisted across reloads); shared scratchpad with one-writer
  lock + takeover; shared notes.
- **Accounts.** Invite-code-gated registration; case-preserved handles
  with case-insensitive lookup; cookie-keyed sessions; sliding 30d
  expiry. Anonymous URL-play of any board you have the link to.
- **Boards.** Per-playthrough boards with owner + member model;
  multi-board-per-puzzle allowed; "leave board" semantics; soft dedup.
- **Persistence.** SQLite via Node's built-in `node:sqlite`; debounced
  15s flush of snapshot / chat / scratchpad.
- **Print.** Client-side PDF generation (jsPDF), not browser print.
- **NYT helper.** "Get from NYT" home-page flow backed by a small Go
  CLI (`dump-nyt-cookies`) that extracts the user's NYT auth cookie
  from their browser.

### Downloads

Pre-built `dump-nyt-cookies` binaries for macOS (arm64/amd64), Linux
(amd64), and Windows (amd64) are attached to this release. They are
optional — you only need one if you want the home-page "Get from NYT"
flow to work without cloning the repo and installing Go yourself.
