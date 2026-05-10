/**
 * Truncate a chat message for the brief preview that flashes over the
 * header when a new line arrives. Strips the leading `!` (the "important"
 * marker — bold in the chat panel, irrelevant for the preview), takes
 * just the first line, and caps to MAX_WORDS words.
 */

const MAX_WORDS = 12;

export function previewText(text: string): string {
  const stripped = text.startsWith("!") ? text.slice(1) : text;
  const firstLine = stripped.split("\n")[0]!;
  const words = firstLine.trim().split(/\s+/);
  if (words.length <= MAX_WORDS) return firstLine;
  return words.slice(0, MAX_WORDS).join(" ") + "...";
}
