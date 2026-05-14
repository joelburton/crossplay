# Print / "Save as PDF" — design notes (superseded)

Originally captured 2026-05-13 as the design for an HTML print page
using `window.print()` + `@media print` CSS. We tried three versions
of that approach (CSS multicolumn, then column-fill: auto + height,
then JS-paginated explicit 2-column flexbox); each lost a different
fight with browser print fragmentation in either Safari or Chrome or
both.

**Active plan**: see [`docs/print-pdf-plan.md`](./print-pdf-plan.md) —
generate the PDF in client JS with jsPDF, bypassing the browser print
pipeline entirely.
