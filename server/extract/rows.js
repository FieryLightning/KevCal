// Table awareness.
//
// OCR returns one line per visual text run, so a table row like
//   "Critical appraisal | Wk 7 (Fri) | 25%"
// arrives as three separate lines and the date loses its title. Research flagged
// exactly this ("a grid is a coordinate system you have to decode"). Grouping
// lines that share a horizontal band restores the row before parsing.

const VERTICAL_OVERLAP = 0.5;   // fraction of the shorter line's height
const MAX_ROW_PARTS = 8;

function overlapRatio(a, b) {
  const aTop = a[1], aBot = a[1] + a[3];
  const bTop = b[1], bBot = b[1] + b[3];
  const inter = Math.min(aBot, bBot) - Math.max(aTop, bTop);
  if (inter <= 0) return 0;
  return inter / Math.min(a[3], b[3]);
}

/**
 * Merge lines that sit on the same visual row into one logical line, keeping the
 * parts so a single cell can still be highlighted later.
 * Paragraph text is untouched: consecutive prose lines do not vertically overlap.
 */
export function groupRows(lines) {
  const withBox = lines.filter((l) => Array.isArray(l.bbox));
  if (withBox.length < 2) return lines;

  const used = new Set();
  const out = [];

  lines.forEach((line, i) => {
    if (used.has(i)) return;
    if (!Array.isArray(line.bbox)) { out.push(line); used.add(i); return; }

    const cluster = [{ line, i }];
    for (let j = i + 1; j < lines.length; j++) {
      if (used.has(j)) continue;
      const other = lines[j];
      if (!Array.isArray(other.bbox)) continue;
      // Only merge things that are side by side, not stacked.
      if (overlapRatio(line.bbox, other.bbox) >= VERTICAL_OVERLAP) {
        cluster.push({ line: other, i: j });
        if (cluster.length >= MAX_ROW_PARTS) break;
      }
    }

    cluster.forEach((c) => used.add(c.i));

    if (cluster.length === 1) { out.push(line); return; }

    cluster.sort((a, b) => a.line.bbox[0] - b.line.bbox[0]);
    const parts = cluster.map((c) => c.line);
    const x0 = Math.min(...parts.map((p) => p.bbox[0]));
    const y0 = Math.min(...parts.map((p) => p.bbox[1]));
    const x1 = Math.max(...parts.map((p) => p.bbox[0] + p.bbox[2]));
    const y1 = Math.max(...parts.map((p) => p.bbox[1] + p.bbox[3]));

    out.push({
      text: parts.map((p) => p.text.trim()).join('  '),
      confidence: Math.min(...parts.map((p) => p.confidence ?? 1)),
      page: parts[0].page,
      bbox: [x0, y0, x1 - x0, y1 - y0],
      parts,
      isRow: true,
    });
  });

  // Preserve reading order.
  return out.sort((a, b) => (a.page - b.page) || (a.bbox?.[1] ?? 0) - (b.bbox?.[1] ?? 0));
}
