// Eight visually distinct colors that read clearly against a white background.
export const CHAT_PALETTE = [
  "#d62728", // red
  "#1f77b4", // blue
  "#2ca02c", // green
  "#ff7f0e", // orange
  "#9467bd", // purple
  "#8c564b", // brown
  "#e377c2", // pink
  "#17becf", // teal
];

export function colorForName(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) {
    h = (h * 31 + name.charCodeAt(i)) >>> 0;
  }
  return CHAT_PALETTE[h % CHAT_PALETTE.length]!;
}

export type ChatIdentity = { name: string; color: string };

export function readChatIdentity(): ChatIdentity {
  const params = new URLSearchParams(location.search);
  const raw = params.get("name")?.trim();
  const name = raw && raw.length > 0 ? raw.slice(0, 32) : `Rando${Math.floor(Math.random() * 90 + 10)}`;
  return { name, color: colorForName(name) };
}
