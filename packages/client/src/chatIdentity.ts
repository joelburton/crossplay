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

export function makeIdentity(name: string): ChatIdentity {
  const cleaned = clean(name);
  return { name: cleaned, color: colorForName(cleaned) };
}

// Priority: ?name= URL param > localStorage > random Rando<2 digits>.
// URL param and explicit edits also write through to localStorage so the next
// visit (without a URL param) picks up the same name.
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

export function persistName(name: string): void {
  saveStoredName(clean(name));
}

export const NAME_MAX = MAX_NAME_LEN;
