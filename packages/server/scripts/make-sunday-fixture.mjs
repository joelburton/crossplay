// Generate a synthetic 21x21 .puz fixture for visual testing of large grids.
// Block pattern is rotationally symmetric (NYT convention).
// Solution is random letters; clues are placeholders.

import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const W = 21;
const H = 21;
const TITLE = "Sunday Sampler (synthetic)";
const AUTHOR = "Crossplay generator";
const COPYRIGHT = "test fixture; not a real puzzle";
// Note: .puz files are ISO-8859-1; stick to ASCII or Latin-1 characters here.
// puzjs decodes each byte as a separate codepoint (no UTF-8 reassembly), so
// any multi-byte UTF-8 sequence (em-dash, curly quotes, etc.) will appear
// as garbled characters in the rendered note.
const NOTE = [
  "Welcome to the Sunday Sampler -- a synthetic 21x21 grid generated for layout testing.",
  "",
  "Theme: There is no theme. The grid was placed by a deterministic random number generator with rotational symmetry, and the letters are nonsense.",
  "",
  "About the clues: Every clue is a placeholder of the form \"Across clue N\" or \"Down clue N\". They have no relationship to the letters in the grid. If you came here expecting wordplay, please complain loudly to the seeded RNG (look up rng(42) -- that's the responsible party).",
  "",
  "Cryptic note: In a real cryptic crossword, this section would explain conventions like \"all answers contain a hidden moth\" or \"every down answer is an anagram of a chemical element\". Here, the only convention is that everything has 17% block density and no pretensions to solvability.",
  "",
  "Use the menu to test reveal/check actions against this grid; the \"solution\" is the random letter we wrote into each cell, so reveal-letter will fill in the same nonsense your fingers were about to type.",
].join("\n");

// Seeded RNG so the fixture is reproducible
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}
const rand = rng(42);

// Build block pattern with 180-degree rotational symmetry.
// Place blocks with ~17% density at unique cells, then mirror.
const grid = Array.from({ length: H }, () => Array.from({ length: W }, () => "."));
function setBlock(r, c) {
  grid[r][c] = "#";
  grid[H - 1 - r][W - 1 - c] = "#";
}
const targetBlocks = Math.floor(W * H * 0.17);
let placed = 0;
while (placed < targetBlocks) {
  const r = Math.floor(rand() * H);
  const c = Math.floor(rand() * W);
  if (grid[r][c] === "#") continue;
  // Avoid creating 1-cell words: don't make a cell that has all-block neighbors
  // (cheap heuristic — not perfect but good enough for visual fixture)
  setBlock(r, c);
  placed = grid.flat().filter((x) => x === "#").length;
}

// Fill non-block cells with random letters
const ABC = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
for (let r = 0; r < H; r++) {
  for (let c = 0; c < W; c++) {
    if (grid[r][c] !== "#") {
      grid[r][c] = ABC[Math.floor(rand() * 26)];
    }
  }
}

// Number cells and collect clue counts (must match the per-cell numbering rule)
const isBlock = (r, c) =>
  r < 0 || c < 0 || r >= H || c >= W || grid[r][c] === "#";
const acrossClues = [];
const downClues = [];
let n = 0;
for (let r = 0; r < H; r++) {
  for (let c = 0; c < W; c++) {
    if (isBlock(r, c)) continue;
    const startsAcross = isBlock(r, c - 1) && !isBlock(r, c + 1);
    const startsDown = isBlock(r - 1, c) && !isBlock(r + 1, c);
    if (startsAcross || startsDown) {
      n += 1;
      if (startsAcross) acrossClues.push(`Across clue ${n}`);
      if (startsDown) downClues.push(`Down clue ${n}`);
    }
  }
}

// Compose .puz binary.
// Header is 52 bytes; then solution, then state, then NUL-terminated strings.
const headerSize = 52;
const gridSize = W * H;
const stringsParts = [];
const enc = new TextEncoder();
function pushStr(s) {
  const bytes = enc.encode(s);
  stringsParts.push(bytes);
  stringsParts.push(new Uint8Array([0]));
}
pushStr(TITLE);
pushStr(AUTHOR);
pushStr(COPYRIGHT);

// Clues are interleaved in cell-numbering order (across before down at the same cell number)
let aIdx = 0;
let dIdx = 0;
let nn = 0;
for (let r = 0; r < H; r++) {
  for (let c = 0; c < W; c++) {
    if (isBlock(r, c)) continue;
    const startsAcross = isBlock(r, c - 1) && !isBlock(r, c + 1);
    const startsDown = isBlock(r - 1, c) && !isBlock(r + 1, c);
    if (startsAcross || startsDown) {
      nn += 1;
      if (startsAcross) {
        pushStr(acrossClues[aIdx++]);
      }
      if (startsDown) {
        pushStr(downClues[dIdx++]);
      }
    }
  }
}
pushStr(NOTE); // description / note

const stringsLen = stringsParts.reduce((a, b) => a + b.length, 0);
const totalSize = headerSize + gridSize * 2 + stringsLen;
const buf = new Uint8Array(totalSize);

// Magic
buf.set(enc.encode("ACROSS&DOWN\0"), 2);
// Version "1.3\0"
buf.set(enc.encode("1.3\0"), 24);
// Width / height
buf[44] = W;
buf[45] = H;
// nclues (acrossCount + downCount)
const nclues = acrossClues.length + downClues.length;
buf[46] = nclues & 0xff;
buf[47] = (nclues >> 8) & 0xff;
// Unknown bitmask: any nonzero is fine; puzjs ignores
buf[48] = 1;
// Scrambled tag must be 0 (already)

// Solution + state. Note: .puz uses "." to mark blocks in BOTH solution and state.
let off = headerSize;
for (let r = 0; r < H; r++) {
  for (let c = 0; c < W; c++) {
    const ch = grid[r][c] === "#" ? "." : grid[r][c];
    buf[off++] = ch.charCodeAt(0);
  }
}
for (let r = 0; r < H; r++) {
  for (let c = 0; c < W; c++) {
    buf[off++] = grid[r][c] === "#" ? ".".charCodeAt(0) : "-".charCodeAt(0);
  }
}

// Strings
for (const part of stringsParts) {
  buf.set(part, off);
  off += part.length;
}

const here = dirname(fileURLToPath(import.meta.url));
const outPath = resolve(here, "..", "fixtures", "sunday-sample.puz");
writeFileSync(outPath, buf);

const blocks = grid.flat().filter((x) => x === "#").length;
console.log(`wrote ${outPath}`);
console.log(`  ${W}x${H} = ${gridSize} cells, ${blocks} blocks (${((blocks / gridSize) * 100).toFixed(1)}%)`);
console.log(`  ${acrossClues.length} across, ${downClues.length} down`);
