/**
 * Top-level: assemble title + grid + clues into a single PDF Blob.
 * The only side-effecting entry point of the print module.
 */

import { jsPDF } from "jspdf";
import type { PuzzleState } from "@crossplay/shared";
import { computeLayout } from "./layout";
import { drawTitle } from "./title";
import { drawGrid } from "./grid";
import { buildItems, drawPlacements, measureItems, paginate } from "./clues";

export async function generateCrosswordPdf(state: PuzzleState): Promise<Blob> {
  const { meta, snapshot } = state;
  const doc = new jsPDF({ orientation: "portrait", unit: "pt", format: "letter" });

  const layout = computeLayout(meta.width);

  drawTitle(doc, meta, layout.titleRect);
  drawGrid(doc, snapshot, layout.gridRect);

  const items = buildItems(meta.clues);
  // Measure against the first region's width — all small/large layout
  // regions are the same width within a given layout, and the
  // continuation regions for that layout are also sized to match.
  const measureWidth = layout.regions[0]?.w ?? layout.gridRect.w;
  const laidOut = measureItems(doc, items, measureWidth);
  const placements = paginate(laidOut, layout.regions, layout.continuationCols);
  drawPlacements(doc, placements);

  return doc.output("blob");
}
