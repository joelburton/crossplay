// Font name + size constants shared across the print modules. jsPDF
// ships the Base 14 PDF standard fonts; we only use Times (serif) and
// Helvetica (sans-serif), so no font files need loading.

export const FONT_SERIF = "times";
export const FONT_SANS = "helvetica";

// Title block
export const TITLE_SIZE = 16;
// Byline (author + copyright stacked on two right-aligned lines):
// kept small so the whole block fits beside the left-aligned title.
export const BYLINE_SIZE = 8;

// Grid
export const NUMBER_SIZE = 5;
// Cell letter sizing is computed from cell size (≈ 0.6 × cell), so it
// isn't a constant.

// Clues
export const HEADING_SIZE = 10;
export const CLUE_SIZE = 9.5;
export const CLUE_LINE_HEIGHT = 11.5;
export const CLUE_NUM_GUTTER = 16;
export const CLUE_RIGHT_PAD = 2;
export const CLUE_BOTTOM_MARGIN = 3;
export const HEADING_BOTTOM_PAD = 4;
