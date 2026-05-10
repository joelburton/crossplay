/**
 * Player identity for chat and presence.
 *
 * A "chat identity" is just a (name, color) pair. The name is whatever
 * the user typed (or a generated default); the color is derived
 * deterministically from the name via `colorForName` so the same name
 * always renders in the same color across all clients in a room without
 * any server coordination.
 *
 * Identity also flows to the board: optimistic fills carry `senderColor`
 * so other players see the typer's color flash on the cell for 3s.
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

const NAME_KEY = "crossplay.chatName";
const MAX_NAME_LEN = 32;

function loadStoredName(): string | null {
  try {
    const v = localStorage.getItem(NAME_KEY);
    return v && v.trim().length > 0 ? v.trim().slice(0, MAX_NAME_LEN) : null;
  } catch {
    return null;
  }
}

function saveStoredName(name: string): void {
  try {
    localStorage.setItem(NAME_KEY, name);
  } catch {
    // localStorage might be disabled (private mode, quota); silently ignore.
  }
}

function clean(name: string): string {
  return name.trim().slice(0, MAX_NAME_LEN);
}

/** Build an identity from a (possibly messy) name input. Trims and caps
 *  to 32 chars, then derives the color. */
export function makeIdentity(name: string): ChatIdentity {
  const cleaned = clean(name);
  return { name: cleaned, color: colorForName(cleaned) };
}

/**
 * Resolve the current player's identity at app startup.
 *
 * Priority (highest first):
 *   1. `?name=` URL parameter — useful for "share two URLs with two
 *      friends" testing; also written through to localStorage so the
 *      next visit without `?name=` keeps the same name.
 *   2. Previously stored name in localStorage.
 *   3. A random fallback `Rando<NN>` (NN = 10–99).
 */
export function readChatIdentity(): ChatIdentity {
  const params = new URLSearchParams(location.search);
  const fromUrl = params.get("name")?.trim();
  if (fromUrl && fromUrl.length > 0) {
    const cleaned = clean(fromUrl);
    saveStoredName(cleaned);
    return makeIdentity(cleaned);
  }
  const stored = loadStoredName();
  if (stored) return makeIdentity(stored);
  return makeIdentity(`Rando${Math.floor(Math.random() * 90 + 10)}`);
}

/** Save a name to localStorage so the next visit (without `?name=`)
 *  picks it up. Called on rename and on URL-param-driven loads. */
export function persistName(name: string): void {
  saveStoredName(clean(name));
}

export const NAME_MAX = MAX_NAME_LEN;
