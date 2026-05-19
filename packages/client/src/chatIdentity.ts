/**
 * Player identity for chat and presence.
 *
 * A "chat identity" is just a (name, color) pair. The name is the
 * account handle for authed users and a stable `Rando<NN>` for anons;
 * the color is derived deterministically from the name via
 * `colorForName` so the same name always renders in the same color
 * across all clients in a room without any server coordination.
 *
 * Identity also flows to the board: optimistic fills carry
 * `senderColor` so other players see the typer's color flash on the
 * cell for 3s.
 *
 * Identity is fixed for the lifetime of a session — authed users
 * can't pick a chat name distinct from their handle, and anons can't
 * customize their `Rando<NN>`. The anon name is persisted to
 * localStorage so a single browser stays the same `Rando<NN>` across
 * reloads (otherwise peers would see "Rando23 left, Rando47 joined"
 * every refresh). If a future preference brings back custom chat
 * names, the right place for it is a `display_name` column on
 * `users`, not a per-browser localStorage hack.
 */

// Eight high-saturation colors picked across the hue wheel so adjacent
// players are easy to distinguish at a glance and stay legible on white.
export const CHAT_PALETTE = [
  "#ef4444", // red
  "#f97316", // orange
  "#ca8a04", // amber
  "#22c55e", // green
  "#06b6d4", // cyan
  "#3b82f6", // blue
  "#8b5cf6", // violet
  "#ec4899", // pink
];

/** Map a name to one of the eight palette colors via a small string
 *  hash. Deterministic — every client that sees the name "Alice" will
 *  pick the same color, which is how we agree on player colors without
 *  any server round‑trip. */
export function colorForName(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) {
    h = (h * 31 + name.charCodeAt(i)) >>> 0;
  }
  return CHAT_PALETTE[h % CHAT_PALETTE.length]!;
}

export type ChatIdentity = { name: string; color: string };

const ANON_NAME_KEY = "crossplay.anonName";
const ANON_NAME_RE = /^Rando[0-9]{2}$/;

/** Build an identity from a name. Used for both authed and anon
 *  cases — the difference is just where the name comes from. */
export function makeIdentity(name: string): ChatIdentity {
  return { name, color: colorForName(name) };
}

/** Generate a fresh `Rando<NN>` with NN in 10–99. */
function randomAnonName(): string {
  return `Rando${Math.floor(Math.random() * 90 + 10)}`;
}

function loadStoredAnonName(): string | null {
  try {
    const v = localStorage.getItem(ANON_NAME_KEY);
    return v && ANON_NAME_RE.test(v) ? v : null;
  } catch {
    return null;
  }
}

function saveStoredAnonName(name: string): void {
  try {
    localStorage.setItem(ANON_NAME_KEY, name);
  } catch {
    // localStorage might be disabled (private mode, quota); silently ignore.
  }
}

/**
 * Resolve the current player's identity. Authed users always show
 * their account handle. Anons get a `Rando<NN>` that's persisted to
 * localStorage so the same browser stays the same anon identity
 * across reloads.
 *
 * `preferredColor` (when set in the authed user's prefs) overrides
 * the deterministic name-hash color. Anons can't set a preference
 * today — they get the name-hash color regardless.
 */
export function resolveChatIdentity(
  authedHandle: string | null,
  preferredColor: string | null = null,
): ChatIdentity {
  const base = (() => {
    if (authedHandle && authedHandle.trim().length > 0) {
      return makeIdentity(authedHandle.trim());
    }
    const stored = loadStoredAnonName();
    if (stored) return makeIdentity(stored);
    const fresh = randomAnonName();
    saveStoredAnonName(fresh);
    return makeIdentity(fresh);
  })();
  if (preferredColor && /^#[0-9a-f]{6}$/i.test(preferredColor)) {
    return { ...base, color: preferredColor.toLowerCase() };
  }
  return base;
}
