// Patch the description ("note") field of a .puz file in place.
// Usage: node set-puz-note.mjs <path/to/file.puz> "<note text>"
//
// .puz format: header (52 bytes) + solution (W*H) + state (W*H) +
// NUL-terminated strings: title, author, copyright, [interleaved clues],
// description, then optional extension blocks (GRBS/GEXT/RTBL/etc.).
//
// puzjs (the reader we use) does not verify the header checksums, so
// patching bytes in place works for our app even though other readers
// would consider the checksum stale.

import { readFileSync, writeFileSync } from "node:fs";

const [path, note] = process.argv.slice(2);
if (!path || note == null) {
  console.error("usage: set-puz-note.mjs <file.puz> <note text>");
  process.exit(1);
}

const buf = readFileSync(path);
const ncol = buf[44];
const nrow = buf[45];
const blockCh = ".".charCodeAt(0);
const isBlock = (r, c) =>
  r < 0 || c < 0 || r >= nrow || c >= ncol || buf[52 + r * ncol + c] === blockCh;

// Count clue strings (one per across/down start at numbered cells).
let nClues = 0;
for (let r = 0; r < nrow; r++) {
  for (let c = 0; c < ncol; c++) {
    if (isBlock(r, c)) continue;
    if (isBlock(r, c - 1) && !isBlock(r, c + 1)) nClues++;
    if (isBlock(r - 1, c) && !isBlock(r + 1, c)) nClues++;
  }
}

// Walk past the (3 fixed + nClues) NUL terminators to land on description start.
let off = 52 + 2 * ncol * nrow;
const stringsToSkip = 3 + nClues;
let skipped = 0;
while (off < buf.length && skipped < stringsToSkip) {
  if (buf[off] === 0) skipped++;
  off++;
}
if (skipped !== stringsToSkip) {
  console.error("could not locate description; file may be malformed");
  process.exit(1);
}
const descStart = off;
let descEnd = off;
while (descEnd < buf.length && buf[descEnd] !== 0) descEnd++;
if (descEnd >= buf.length) {
  console.error("description not NUL-terminated");
  process.exit(1);
}

const before = buf.subarray(0, descStart);
const newDesc = Buffer.from(note + "\0", "utf-8");
const after = buf.subarray(descEnd + 1);
const out = Buffer.concat([before, newDesc, after]);

writeFileSync(path, out);
console.log(
  `patched ${path}: description ${descEnd - descStart} bytes -> ${newDesc.length - 1} bytes`,
);
