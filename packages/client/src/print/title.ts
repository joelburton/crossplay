/**
 * Title block renderer. Draws title (left) + author/copyright (right,
 * stacked) at the top of page 1. Compact: byline lines are small so
 * the whole block fits in TITLE_BLOCK_H without crowding the grid.
 */

import type { jsPDF } from "jspdf";
import type { PuzzleMeta } from "@crossplay/shared";
import type { Rect } from "./layout";
import { BYLINE_SIZE, FONT_SERIF, TITLE_SIZE } from "./fonts";

/**
 * Draw the title block into `rect`. Title is left-aligned Times-Bold;
 * author + copyright are right-aligned and stacked on two lines in a
 * small font so they fit beside the title without inflating the
 * block height.
 */
export function drawTitle(doc: jsPDF, meta: PuzzleMeta, rect: Rect): void {
  const leftX = rect.x;
  const rightX = rect.x + rect.w;

  doc.setFont(FONT_SERIF, "bold");
  doc.setFontSize(TITLE_SIZE);
  const titleBaseline = rect.y + TITLE_SIZE;
  doc.text(meta.title || "Untitled", leftX, titleBaseline);

  if (meta.author || meta.copyright) {
    doc.setFont(FONT_SERIF, "normal");
    doc.setFontSize(BYLINE_SIZE);
    // Two stacked right-aligned lines. Anchor the pair to the title's
    // baseline so they sit visually balanced beside it: first line
    // baseline slightly above the title baseline, second slightly
    // below — keeps the whole block compact.
    const line1Y = rect.y + BYLINE_SIZE;
    const line2Y = line1Y + BYLINE_SIZE + 2;
    if (meta.author) doc.text(meta.author, rightX, line1Y, { align: "right" });
    if (meta.copyright) doc.text(meta.copyright, rightX, line2Y, { align: "right" });
  }
}
