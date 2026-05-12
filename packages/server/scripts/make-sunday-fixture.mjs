// Generate a synthetic 21x21 fixture for visual testing of large
// grids and every special crossword feature we currently support.
//
// Two outputs are written side by side:
//
//   sunday-sample.puz  — legacy binary; carries every feature .puz can
//                        represent (circle, shaded cell, multi-letter
//                        rebus, very-long clue). No given letters,
//                        Schrödinger alternates, or null cells — the
//                        .puz format has no slot for any of them.
//
//   sunday-sample.ipuz — modern JSON; everything in the .puz plus an
//                        author-prefilled "given" cell, a Schrödinger
//                        cell with two accepted answers, and a few
//                        irregular-grid "null" cells (transparent
//                        voids at the corners, making the outer shape
//                        non-rectangular).
//
// Block pattern is rotationally symmetric (NYT convention) but specific
// cells are reserved so the demonstration features always land on open
// squares.

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
  "Theme: There is no theme. The grid was placed by a deterministic random number generator with rotational symmetry, and the letters are nonsense. A handful of cells are decorated with features (circle, shading, rebus, given, Schrodinger) so the rendering can be eyeballed end to end.",
  "",
  "Feature locations: the demonstration cells live in the top-left quadrant so you don't have to scroll. Look for a circled letter, a shaded square, a HEART rebus, and (in the .ipuz fixture only) an underlined given letter plus a Schrodinger cell that accepts two different answers.",
  "",
  "About the clues: Every clue is a placeholder of the form \"Across clue N\" or \"Down clue N\" except for one deliberately overlong Across clue near the start, which exists to test how the layout handles a wraparound cryptic.",
].join("\n");

// One Across clue is replaced with this very long string so we can
// verify how the clue panels and the narrow-mode strip handle a
// cryptic-length entry. Stays ASCII to round-trip through .puz.
const LONG_CLUE_TEXT =
  "A deliberately overlong clue intended to test how the clue panels, the active-clue header pill, and the narrow-mode below-the-grid strip cope when an author writes one of those rambling cryptic surfaces that doesn't end before the reader has run out of patience or screen real estate";

// Seeded RNG so the fixture is reproducible
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}
const rand = rng(42);

// Reserved cells: we'll plant features here and want to guarantee
// they (and their rotational mirrors) are NOT blocks. The mirror
// reservation keeps the symmetric block pattern from collapsing onto
// these squares from the other direction.
const RESERVED = new Set();
function reserve(r, c) {
  RESERVED.add(r * W + c);
  RESERVED.add((H - 1 - r) * W + (W - 1 - c));
}

// Feature cell coordinates. Picked in the upper-left so they're
// visible without scrolling on any layout. Two adjacent shaded cells
// (1,3) and (1,4) make the gray shading obviously different from a
// hidden ("null") cutout — the shaded cells still have letters and
// black borders, while the corner nulls are bare white voids.
const CIRCLE_RC = [1, 1];
const SHADE_RC = [1, 3];
const SHADE2_RC = [1, 4];
const REBUS_RC = [1, 7]; // first letter goes in the main solution grid; full answer in RTBL
const GIVEN_RC = [3, 1]; // ipuz only
const SCHRO_RC = [3, 3]; // ipuz only
const REBUS_ANSWER = "HEART";
const GIVEN_LETTER = "G";
const SCHRO_PRIMARY = "S";
const SCHRO_ALTERNATE = "Z";

[CIRCLE_RC, SHADE_RC, SHADE2_RC, REBUS_RC, GIVEN_RC, SCHRO_RC].forEach(([r, c]) => reserve(r, c));

// Build block pattern with 180-degree rotational symmetry.
const grid = Array.from({ length: H }, () => Array.from({ length: W }, () => "."));
function setBlock(r, c) {
  grid[r][c] = "#";
  grid[H - 1 - r][W - 1 - c] = "#";
}

// Null-cell mask: corner-cutting triangles, so the .ipuz fixture has
// a non-rectangular outer shape. .puz can't represent null cells, so
// those same coordinates render there as regular black blocks — the
// two fixtures keep matching word structure / numbering, only the
// outer-edge rendering differs. (Rotational mirrors are added
// automatically.)
const NULL_MASK = new Set();
function carve(r, c) {
  NULL_MASK.add(r * W + c);
  NULL_MASK.add((H - 1 - r) * W + (W - 1 - c));
}
// Top-left triangle and its 180° mirror (bottom-right).
carve(0, 0);
carve(0, 1);
carve(1, 0);
// Top-right triangle and its 180° mirror (bottom-left).
carve(0, W - 1);
carve(0, W - 2);
carve(1, W - 1);

// Seed the null-mask cells as blocks before random placement so the
// random pass doesn't waste its budget on them or place asymmetric
// neighbors.
for (const idx of NULL_MASK) {
  const r = Math.floor(idx / W);
  const c = idx % W;
  grid[r][c] = "#";
}

const targetBlocks = Math.floor(W * H * 0.17);
let placed = grid.flat().filter((x) => x === "#").length;
let safety = 10000;
while (placed < targetBlocks && safety-- > 0) {
  const r = Math.floor(rand() * H);
  const c = Math.floor(rand() * W);
  if (grid[r][c] === "#") continue;
  if (RESERVED.has(r * W + c)) continue;
  if (RESERVED.has((H - 1 - r) * W + (W - 1 - c))) continue;
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

// Plant feature letters into the random fill. For the rebus cell the
// main grid stores the first letter ("H" for "HEART"); the full
// answer rides on the GRBS/RTBL extension.
grid[REBUS_RC[0]][REBUS_RC[1]] = REBUS_ANSWER[0];
grid[GIVEN_RC[0]][GIVEN_RC[1]] = GIVEN_LETTER;
grid[SCHRO_RC[0]][SCHRO_RC[1]] = SCHRO_PRIMARY;

if ([CIRCLE_RC, SHADE_RC, REBUS_RC, GIVEN_RC, SCHRO_RC].some(([r, c]) => grid[r][c] === "#")) {
  throw new Error("reservation collapsed: a feature cell ended up a block");
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
// Replace one Across clue with the long-clue stress test.
if (acrossClues.length > 1) acrossClues[1] = LONG_CLUE_TEXT;

// -----------------------------------------------------------------
// .puz output
// -----------------------------------------------------------------

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

// Clues interleaved in cell-numbering order (across before down at the same cell number)
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
      if (startsAcross) pushStr(acrossClues[aIdx++]);
      if (startsDown) pushStr(downClues[dIdx++]);
    }
  }
}
pushStr(NOTE);

const stringsLen = stringsParts.reduce((a, b) => a + b.length, 0);

// Extension sections. puzjs's writer uses big-endian length and a zero
// checksum on each extension header — we match its convention so the
// file round-trips cleanly through `parsePuzBuffer`.
function extension(code, data) {
  const codeBytes = enc.encode(code);
  if (codeBytes.length !== 4) throw new Error(`code must be 4 bytes, got '${code}'`);
  const header = new Uint8Array(8);
  header.set(codeBytes, 0);
  // length, big-endian — matches puzjs.
  header[4] = (data.length >> 8) & 0xff;
  header[5] = data.length & 0xff;
  // checksum bytes left zero.
  const out = new Uint8Array(header.length + data.length);
  out.set(header, 0);
  out.set(data, header.length);
  return out;
}

// GEXT (per-cell markup): 0x80 = circle, 0x08 = shaded.
const gext = new Uint8Array(gridSize);
gext[CIRCLE_RC[0] * W + CIRCLE_RC[1]] |= 0x80;
gext[SHADE_RC[0] * W + SHADE_RC[1]] |= 0x08;
gext[SHADE2_RC[0] * W + SHADE2_RC[1]] |= 0x08;
const gextSection = extension("GEXT", gext);

// GRBS + RTBL (rebus). GRBS stores `sols.indexOf(answer) + 1` per cell
// (0 means "no rebus"); RTBL is "k:V;" pairs with k = 0-based index.
const rebusSols = [REBUS_ANSWER];
const grbs = new Uint8Array(gridSize);
grbs[REBUS_RC[0] * W + REBUS_RC[1]] = 1;
const rtblString = rebusSols.map((s, i) => `${i}:${s}`).join(";") + ";";
const grbsSection = extension("GRBS", grbs);
const rtblSection = extension("RTBL", enc.encode(rtblString));

const extrasLen = gextSection.length + grbsSection.length + rtblSection.length;

const totalSize = headerSize + gridSize * 2 + stringsLen + extrasLen;
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

// Solution + state. .puz uses "." to mark blocks in BOTH solution and state.
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

// Extensions
buf.set(gextSection, off); off += gextSection.length;
buf.set(grbsSection, off); off += grbsSection.length;
buf.set(rtblSection, off); off += rtblSection.length;

const here = dirname(fileURLToPath(import.meta.url));
const puzPath = resolve(here, "..", "fixtures", "sunday-sample.puz");
writeFileSync(puzPath, buf);

// -----------------------------------------------------------------
// .ipuz output (richer: adds given + Schrödinger on top of .puz feats)
// -----------------------------------------------------------------

const cellIdAt = (() => {
  const ids = Array.from({ length: H }, () => Array(W).fill(0));
  let k = 0;
  for (let r = 0; r < H; r++) {
    for (let c = 0; c < W; c++) {
      if (grid[r][c] === "#") continue;
      const startsAcross = isBlock(r, c - 1) && !isBlock(r, c + 1);
      const startsDown = isBlock(r - 1, c) && !isBlock(r + 1, c);
      if (startsAcross || startsDown) {
        k += 1;
        ids[r][c] = k;
      }
    }
  }
  return ids;
})();

const ipuzPuzzleGrid = [];
const ipuzSolutionGrid = [];
for (let r = 0; r < H; r++) {
  const puzRow = [];
  const solRow = [];
  for (let c = 0; c < W; c++) {
    if (NULL_MASK.has(r * W + c)) {
      // Irregular-grid void: ipuz uses JSON null in both puzzle and
      // solution grids. (The .puz fixture has these same coordinates
      // as regular blocks so word structure matches.)
      puzRow.push(null);
      solRow.push(null);
      continue;
    }
    if (grid[r][c] === "#") {
      puzRow.push("#");
      solRow.push("#");
      continue;
    }
    const num = cellIdAt[r][c];
    const cellValue = num > 0 ? num : 0;

    // Puzzle-grid styling and givens
    const isCircle = r === CIRCLE_RC[0] && c === CIRCLE_RC[1];
    const isShade =
      (r === SHADE_RC[0] && c === SHADE_RC[1]) ||
      (r === SHADE2_RC[0] && c === SHADE2_RC[1]);
    const isGiven = r === GIVEN_RC[0] && c === GIVEN_RC[1];
    if (isCircle) {
      puzRow.push({ cell: cellValue, style: { shapebg: "circle" } });
    } else if (isShade) {
      puzRow.push({ cell: cellValue, style: { color: "#dddddd" } });
    } else if (isGiven) {
      puzRow.push({ cell: cellValue, value: GIVEN_LETTER });
    } else {
      puzRow.push(cellValue);
    }

    // Solution: rebus full answer + Schrödinger alternates
    const isRebus = r === REBUS_RC[0] && c === REBUS_RC[1];
    const isSchro = r === SCHRO_RC[0] && c === SCHRO_RC[1];
    if (isRebus) {
      solRow.push(REBUS_ANSWER);
    } else if (isSchro) {
      solRow.push({ value: SCHRO_PRIMARY, alternates: [SCHRO_ALTERNATE] });
    } else {
      solRow.push(grid[r][c]);
    }
  }
  ipuzPuzzleGrid.push(puzRow);
  ipuzSolutionGrid.push(solRow);
}

const ipuzObj = {
  version: "http://ipuz.org/v2",
  kind: ["http://ipuz.org/crossword#1"],
  title: TITLE,
  author: AUTHOR,
  copyright: COPYRIGHT,
  notes: NOTE,
  dimensions: { width: W, height: H },
  puzzle: ipuzPuzzleGrid,
  solution: ipuzSolutionGrid,
  clues: {
    Across: acrossClues.map((text, i) => {
      // Across clue numbers correspond 1:1 with the order acrossClues
      // was built; recover them by walking the grid the same way.
      return null;
    }),
    Down: downClues.map(() => null),
  },
};

// Recompute clue lists with explicit numbers so the output is a proper
// ipuz file (the placeholder lists above were just sized arrays).
{
  const across = [];
  const down = [];
  let k = 0;
  let ai = 0;
  let di = 0;
  for (let r = 0; r < H; r++) {
    for (let c = 0; c < W; c++) {
      if (grid[r][c] === "#") continue;
      const startsAcross = isBlock(r, c - 1) && !isBlock(r, c + 1);
      const startsDown = isBlock(r - 1, c) && !isBlock(r + 1, c);
      if (startsAcross || startsDown) {
        k += 1;
        if (startsAcross) across.push([k, acrossClues[ai++]]);
        if (startsDown) down.push([k, downClues[di++]]);
      }
    }
  }
  ipuzObj.clues.Across = across;
  ipuzObj.clues.Down = down;
}

const ipuzPath = resolve(here, "..", "fixtures", "sunday-sample.ipuz");
writeFileSync(ipuzPath, JSON.stringify(ipuzObj, null, 2));

const blocks = grid.flat().filter((x) => x === "#").length;
console.log(`wrote ${puzPath}`);
console.log(`  ${W}x${H} = ${gridSize} cells, ${blocks} blocks (${((blocks / gridSize) * 100).toFixed(1)}%)`);
console.log(`  ${acrossClues.length} across, ${downClues.length} down`);
console.log(`  features: circle@(${CIRCLE_RC}) shade@(${SHADE_RC}),(${SHADE2_RC}) rebus@(${REBUS_RC})=${REBUS_ANSWER} long-clue@A${(ipuzObj.clues.Across[1] ?? [])[0]}`);
console.log(`wrote ${ipuzPath}`);
console.log(`  + given@(${GIVEN_RC})=${GIVEN_LETTER} schrodinger@(${SCHRO_RC})=${SCHRO_PRIMARY}/${SCHRO_ALTERNATE} nulls=${NULL_MASK.size}`);
