# Print to PDF — implementation plan

Captured 2026-05-13. This is the active plan; `docs/print-design.md`
describes the abandoned HTML-print approach for historical context.

## Why a PDF library instead of HTML/CSS print

Earlier attempts used `window.print()` with an `@media print` CSS
stylesheet on a dedicated `/b/:id/print` route. Three layout strategies
were tried (CSS multicolumn with `column-fill: balance`, then
`column-fill: auto` with explicit height, then JS-paginated explicit
2-column flexbox). Each lost a different fight with browser print
fragmentation:

- **Safari**: multicolumn renders fine in the on-screen preview but
  the print pipeline reliably collapses it to a single column. Even
  the JS-paginated flexbox version produces split-mid-line clue text
  on the printed output.
- **Chrome**: similar fragmentation bugs in different places. The
  most recent version splits the page-1 `<section>` between header
  and content despite content fitting.
- **Both**: margin / line-height metrics differ subtly between
  measurement DOM and final print rendering. The on-screen
  preview was never trustworthy as a predictor of what would print.

The fundamental problem: we don't control the print fragmentation
algorithm and it differs per browser. A PDF library produces a fixed
byte sequence; every PDF viewer renders it identically.

## Approach: jsPDF, lazy-loaded

Use [jsPDF](https://github.com/parallax/jsPDF) (MIT, ~150KB gzipped).
Generate the PDF entirely in client JS via draw primitives. The print
route shows a "Generate PDF" button; clicking it produces a Blob and
opens it in a new tab. The user's browser uses its native PDF viewer
from there — save, print, whatever they like.

Lazy-load jsPDF via dynamic `import()` inside the button handler so
the main board route doesn't pay for the bundle weight.

Fonts: jsPDF ships the Base 14 PDF standard fonts (Times, Helvetica,
Courier in their variants). We use **Times** for title + clue body
and **Helvetica** for grid letters / numbers / section headings. No
font files to load.

## Page layouts

12-unit horizontal grid. All small / large decisions key off
`meta.width`.

### Small puzzles (width ≤ 16)

```
+--------+--------+   12 units
|     TITLE       |
+--------+--------+
|  GRID  | Clue 2 |
| (6)    | (6)    |
+--------+        |
| Clue 1 |        |
| (6)    |        |
+--------+--------+
```

Two clue regions:

- **Clue region 1**: 6 units wide × `(content_h − title_h − grid_h − row_gap)` tall.
  Position: lower-left, immediately below the grid.
- **Clue region 2**: 6 units wide × `(content_h − title_h)` tall.
  Position: right half, full content height under the title.

Flow order: region 1 → region 2.

### Large puzzles (width ≥ 17)

```
+----+----+----+   12 units
|     TITLE    |
+---------+----+
|  GRID   | C3 |
|  (8)    | (4)|
+----+----+    |
| C1 | C2 |    |
| (4)| (4)|    |
+----+----+----+
```

Three clue regions:

- **C1**: 4 wide × `(content_h − title_h − grid_h − row_gap)` tall. Lower-left, below grid.
- **C2**: 4 wide × same height. Lower-middle, below grid.
- **C3**: 4 wide × `(content_h − title_h)` tall. Right side, full content height.

Flow order: C1 → C2 → C3.

### Page 2+ (overflow)

When clues exceed page 1, subsequent pages drop the title and grid
entirely and use the column widths of the chosen layout, full content
height per column. Flow continues in reading order:

- **Small**: 2 columns × 6 units wide, full content height.
- **Large**: 3 columns × 4 units wide, full content height.

Same `flow order: leftmost → rightmost`; advance to a new page when
the last column on the current page is full.

## Geometry (pt; 72pt = 1in)

```ts
const PAGE = { w: 612, h: 792 };           // letter portrait
const MARGIN = 18;                         // 0.25in (printer-safe floor)
const CONTENT = { w: 576, h: 756 };        // 8in × 10.5in
const UNIT = CONTENT.w / 12;               // 48pt per column unit
const TITLE_BLOCK_H = 24;                  // title left, byline right (2 lines, small)
const COL_GAP = 12;                        // 1/6in between adjacent clue cols
const ROW_GAP = 12;                        // 1/6in gap between grid and below-grid cluerow
```

`grid_h` is computed: `grid_region_width` / `puzzle.width` gives cell
size; `puzzle.height × cell_size` is grid height. The grid is square
(N × N) so width and height are equal in cells.

## Module structure

```
packages/client/src/print/
  generator.ts    generateCrosswordPdf(meta, snapshot): Promise<Blob>
  layout.ts       computeLayout(meta): { pickSmallOrLarge, regions, gridRect }
  grid.ts         drawGrid(doc, cells, rect): renders cells / numbers / letters / marks
  clues.ts        layoutClues(doc, items, regions, continuationCols): paginates
  title.ts        drawTitle(doc, meta): renders title + byline; returns block height
  fonts.ts        font name + size constants used across modules
  index.ts        re-exports `generateCrosswordPdf`
```

All exports are pure functions taking the jsPDF `doc` and writing to
it. The single side-effect entry is `generateCrosswordPdf`, which
news up the doc and returns `doc.output("blob")`.

## Drawing detail

### Title block (Times)

- Title in Times-Bold 16pt, **left-aligned** at the content left edge.
- Author + copyright stacked on two **right-aligned** lines in Times
  8pt, sitting beside the title within the same `TITLE_BLOCK_H` slot.
  Small font keeps the whole title block compact (24pt vs. the
  original 40pt with a centered byline below) so the grid + clue
  regions get the extra vertical room.

### Grid (Helvetica)

Cell size = `grid_region_width / puzzle.width`. Loop r × c:

- **Block** (`kind: "block"`, not hidden): fill black.
- **Hidden** (`kind: "block", hidden: true`): skip entirely — no fill,
  no stroke. Adjacent open cells draw their own borders.
- **Open cell**: stroke a rect with black 0.5pt. Inside:
  - **Shaded**: fill rect with gray 0.85 *before* stroking (so the
    border sits on top).
  - **Circled**: stroke ellipse inset ~10% from each edge.
  - **Number** (if present): Helvetica 5pt, top-left of cell with a
    1pt offset.
  - **Letter** (`fill` if not null): Helvetica-Bold sized to the cell
    (~0.6 × cell_size), centered. Multi-character (rebus) fills shrink
    further to fit the cell width.
  - **Given**: in addition to the letter, draw a short underline below
    the letter baseline.
  - **Edge marks**:
    - `markRight: "break"`: thick vertical line (1.5pt wide) on the
      right edge, centered on the boundary.
    - `markRight: "hyphen"`: short horizontal dash (~30% of cell
      height wide) on the right edge mid-height.
    - `markBottom`: same logic on the bottom edge.

### Clues (Times)

Per region, advance a y-cursor top-down.

Items in flow:

```
ACROSS heading
each across clue
DOWN heading
each down clue
```

- **Section heading**: Times-Bold 10pt uppercase, line + 2pt thin
  underline, 4pt bottom padding before first clue.
- **Clue**: `<num> <text>`, where:
  - `<num>` is Times-Bold 9.5pt, right-aligned in a fixed 16pt-wide
    gutter at the start of the line.
  - `<text>` is Times 9.5pt, wrapped via `doc.splitTextToSize(text,
    region_width − num_gutter − right_pad)`. Continuation lines
    indent to align with the start of the text (not the number).
  - Line height: ~11.5pt for 9.5pt body.
  - 3pt margin-bottom between clues.

#### Pagination algorithm

```
state: currentRegionIdx, yCursorInRegion, currentPage = 1
for each item:
  compute itemHeight = headerOrClue.lines * lineHeight + bottomMargin
  // orphan rule: heading must have at least its first clue beneath it
  if item is heading and the next item is a clue:
    consider required = itemHeight + nextItemHeight
  else:
    required = itemHeight

  if yCursorInRegion + required > region.bottom:
    advance to next region
    if advanced past last region:
      doc.addPage(); reset to continuation column 0 of new page
  draw item at (region.x, region.y + yCursorInRegion)
  yCursorInRegion += itemHeight
```

When advancing to a fresh page, use the **continuation column count**
for the puzzle's chosen layout (2 cols for small, 3 cols for large).

## UI flow

`PrintPage.tsx` becomes:

1. Fetch board via existing `fetchBoard(boardId)`.
2. Render: loading / error / a "Generate PDF" button.
3. On button click:
   1. Lazy `await import("../print")` — code-split the jsPDF bundle.
   2. `const blob = await generateCrosswordPdf(meta, snapshot)`.
   3. `const url = URL.createObjectURL(blob); window.open(url, "_blank", "noopener");`
4. No on-screen preview. Users get the PDF directly in a new tab via
   their browser's native PDF viewer.

Document title sets `document.title = ${title} — Crossplay` while the
page is open so the new-tab title is meaningful.

Route + menu integration unchanged: the menu's "Print / Save as PDF"
still opens `/b/:id/print` in a new tab.

## Tests

- **`layout.test.ts`**: pure geometry. Assert small vs large dispatch,
  region rectangles' positions and dimensions, continuation column
  counts.
- **`clues.test.ts`**: feed synthetic item heights + region heights;
  assert pagination splits at expected indices, orphan rule kicks in
  when expected.
- **`generator.test.ts`**: smoke test with a mocked `jsPDF` recording
  draw calls. Verify the right font sets, the right number of cells
  drawn, title text present, all clue numbers present.
- **Manual**: 15×15 cryptic (target case), 17×17 themeless, 21×21
  Sunday, 5×5 mini, board with rebus, board with circles + shading,
  board with edge marks. Eyeball Chrome / Safari / Firefox PDF
  viewers.

## Dependencies

```
npm install jspdf
```

`jspdf` only. No type packages needed (jsPDF ships its own).

## Migration

The HTML print page (`PrintPage.tsx` content render + `PrintPage.module.css`)
is gone. Replaced by a small fetch-and-button component. The print
route + menu wiring stay.

Files touched:
- `packages/client/src/components/PrintPage.tsx` — rewritten.
- `packages/client/src/components/PrintPage.module.css` — slimmed to
  basic styles for the page + button.
- `packages/client/src/components/PrintPage.test.tsx` — trimmed to
  fetch + button.
- `packages/client/src/print/*` — new module.
- `packages/client/package.json` — `jspdf` added.
- `CLAUDE.md` — print bullet rewritten.
- `docs/print-design.md` — replaced with a one-liner pointing here.
