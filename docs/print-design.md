# Print / "Save as PDF" — design notes

Captured 2026-05-13. Discussed, not built. Sibling of
`docs/user-preferences-backlog.md` — this is one specific feature
where we sketched the shape but haven't committed to ship.

## Goal

A "Print / Save as PDF" menu action on the board page. The user's
browser handles the dialog; "Save as PDF" is the typical real
target, but if they pick a physical printer that should also work.

## Content

- Title, author, copyright (across the top).
- Grid in its current state — the player's fills are visible.
- Clue lists (across + down) below the grid.

Strip:

- All UI chrome (App header, menus, chat indicator, presence,
  user menu, dialogs, panels).
- Status flags on cells: `revealed` triangles, `wrong` markers,
  cursor / remote-cursor highlights, recent-fill flashes, the
  current-word background.

Keep (these are part of the puzzle, not status):

- Cell numbers.
- Circled cells.
- Shaded cells.
- Given cells' underline (signals "author-supplied" to the reader).
- Rebus answers (multi-letter in small text — already shrinks
  in the cell renderer).
- Word-break / hyphen marks on edges (cryptic enumeration helpers).

"Empty grid for offline solving" is **not** a separate option. If
the user wants that they can Clear the board first and then print.

## Approach: browser print + `@media print` CSS

Not a PDF library. `window.print()` from the menu action, plus
print-only CSS rules. Reliable across Chrome / Safari / Firefox /
Edge for a layout this simple; the historical flakiness of HTML
printing is mostly about complex floats / IE-era multi-column /
custom-font embedding, none of which we have.

A real PDF-library path (jsPDF, pdf-lib) would only buy escape from
the print dialog — the output quality story is the same. Not worth
the ~100 KB dep + manual layout code unless friends genuinely find
"Print → Save as PDF" too indirect.

## Layout

Single top-to-bottom flow, no page-level multi-column trickery:

```
+----------------------------------+
| <title>    by <author>           |
| <copyright>                      |
+----------------------------------+
|                                  |
|              GRID                |
|         (spans full width)       |
|                                  |
+-----------------+----------------+
| Across          | Down           |
| 1. clue         | 1. clue        |
| 4. clue         | 2. clue        |
| ...             | ...            |  ← `column-count: 2` (small)
|                 |                |    or 3 (large)
+-----------------+----------------+
```

The grid always spans the full printable width. Only the clue
container flows in columns. Column count varies with puzzle size
(see below).

### Why not the "grid in 2-of-3 columns" idea

Considered but rejected: for a Sunday (21×21) at 5in wide, cells
would be ~0.24in (≈17pt) which is uncomfortably small to write in.
Full-width gives ~50% more cell area for the same paper. Cost is
that page 1 on a Sunday is grid-only and clues start on page 2 —
acceptable; Sundays overflow to multiple pages anyway and the
visual logic of "grid first, clues after" is cleaner with the
natural break.

## Cell-size math

Letter portrait, 0.5in margins → ~7.5in printable width.

| Puzzle | Cells/side | Cell size |
| --- | --- | --- |
| Mini (5×5)         | 5  | ~1.5in (cap to MAX_CELL_PX) |
| Standard (15×15)   | 15 | ~0.50in/cell — comfortable |
| Themeless (17×17)  | 17 | ~0.44in/cell — comfortable |
| Sunday (21×21)     | 21 | ~0.36in/cell — tight but readable |

Implementation: `Board` sets `--cols: N` inline; print CSS uses
`font-size: calc((100vw - <safety>) / var(--cols)) !important`. The
`!important` is needed because Board already inlines `font-size` for
the screen-size formula. Cap with `min(...)` to avoid absurdly
large cells on a mini.

## Clue column count

- ≤15 cols → 2 clue columns.
- ≥17 cols → 3 clue columns.

Pick at render time from `meta.width`; inline as a CSS custom
property `--clue-columns` and use in print CSS:

```css
@media print {
  .printClues { column-count: var(--clue-columns, 2); }
}
```

## Known CSS gotchas

- **Backgrounds get stripped by default in print** (printers save
  ink). Shaded cells and the cell-number area would lose their
  fills. Add `print-color-adjust: exact;` (formerly
  `-webkit-print-color-adjust`) on the cell elements. Well-
  supported in all modern browsers.
- **Page breaks inside a column** — `break-inside: avoid;` on each
  clue list item so a single clue can't split across the column
  boundary or a page boundary.
- **Fixed-position elements repeat on every page** by default
  (chat indicator, user menu). Explicit `display: none` in print
  on each.
- **The board's screen-mode `font-size` uses `vw`/`dvh`** that
  resolve differently in print. The print rule needs to override
  with `!important` because the inline style otherwise wins.
- **Markup leak through `display: none`** — even hidden elements
  still consume DOM. That's fine, but be careful about anything
  fixed-position that's `display: none`'d in print: it's
  occasionally necessary to add `position: static` too so a stray
  print layout pass doesn't reserve space.

## Future option: Letter landscape

If Sunday cells at 0.36in feel cramped in practice, an explicit
"Print landscape" toggle bumps a Sunday cell to ~0.48in:

```css
@page { size: letter landscape; }
```

Could be a print-dialog preference on the user's OS side (already
available) or surfaced as a per-board / per-user preference once
we decide we care. Not v1.

## Implementation sketch (when we pick this up)

1. `puzzleActions.ts`: add `printPuzzle: () => void`.
2. `PuzzleView`: implement as `() => window.print()`. Add a
   print-only `<div class="printHeader">` with title / author /
   copyright. Set `--cols` and `--clue-columns` as inline CSS vars
   on the wrap.
3. `Menu`: add a "Print / Save as PDF" item.
4. `index.css`: `@page { size: letter portrait; margin: 0.5in; }`
   plus body-level hides for fixed-position chrome.
5. Per-module `@media print` rules:
   - `App.module.css`: hide `.header`.
   - `Cell.module.css`: zero out `.cursor` / `.remoteFrame` /
     `.revealed` / `.wrong` / `.recent` / `.inWord`.
   - `Board.module.css`: cell-size override; `print-color-adjust:
     exact` on cells with backgrounds.
   - `PuzzleView.module.css`: hide `.activeClue` strip; rearrange
     layout to top-to-bottom; `column-count` on `.clues`;
     `break-inside: avoid` on clue items.
   - `ChatIndicator` / `ChatPreview` / `UserMenu` / `ChatPanel` /
     each dialog module: `display: none` on its root.

Whole change is ~150–250 lines of CSS + ~20 lines of JSX / TS.
Maybe a couple hours of focused work plus an hour of cross-browser
sanity-check (eyeball Chrome + Safari + Firefox for a Mini, a
Standard, and a Sunday).
