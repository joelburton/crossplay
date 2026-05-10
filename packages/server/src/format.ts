/**
 * Shared "which parser do I use?" helpers for .puz / .ipuz inputs.
 * Used by the CLI importer (file path) and the HTTP upload route
 * (multipart filename); a single source of truth so the detection
 * rules can't drift between the two entry points.
 */

import { parsePuzBuffer } from "./puzzle.js";
import { parseIpuzBuffer } from "./ipuz.js";

export type PuzzleFormat = "puz" | "ipuz";

/** Pick a parser. Extension wins; otherwise sniff for a leading `{`
 *  (BOM-tolerant) and treat as ipuz, else fall back to .puz. */
export function detectFormat(filename: string | undefined, buffer: Buffer): PuzzleFormat {
  const ext = filename?.toLowerCase().match(/\.(puz|ipuz)$/)?.[1];
  if (ext === "ipuz") return "ipuz";
  if (ext === "puz") return "puz";
  let i = 0;
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) i = 3;
  while (
    i < buffer.length &&
    (buffer[i] === 0x20 || buffer[i] === 0x09 || buffer[i] === 0x0a || buffer[i] === 0x0d)
  )
    i++;
  return buffer[i] === 0x7b ? "ipuz" : "puz"; // '{'
}

/** Dispatch to the right parser. Both throw `IpuzUnsupportedError` on
 *  unsupported features; the caller decides how to surface that. */
export function parsePuzzleBuffer(id: string, buffer: Buffer, format: PuzzleFormat) {
  return format === "ipuz" ? parseIpuzBuffer(id, buffer) : parsePuzBuffer(id, buffer);
}
