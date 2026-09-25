import { renderBodygraph } from '../bodygraph/bodygraph.js';
import { CHART_BACKDROP_BOUNDS, CHART_SURFACE_RIM_WIDTH } from '../bodygraph/chart-backdrop.js';

// SVG images isolate their styles and IDs from the interactive chart.
// Cache by activations, not names or birth data; repeated menu renders are cheap.
const thumbnails = new Map();
const CACHE_LIMIT = 100;
// Include the outer rim and a small antialiasing margin, without resizing cards.
const inset = CHART_SURFACE_RIM_WIDTH / 2 + 1;
const { x, y, width, height } = CHART_BACKDROP_BOUNDS;
const viewBox = [x - inset, y - inset, width + inset * 2, height + inset * 2].join(' ');

export function renderChartThumbnail(chart) {
  const snapshot = { personality: chart.personality || [], design: chart.design || [] };
  const key = JSON.stringify(snapshot);
  if (thumbnails.has(key)) return thumbnails.get(key);
  const drawing = renderBodygraph(snapshot, null, {
    interactive: false, showActivations: false, showLabels: false, showBackdrop: true, idPrefix: 'thumbnail',
  });
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}">${drawing}<style>.bodygraph-gates { display: none; }</style></svg>`;
  const source = `data:image/svg+xml,${encodeURIComponent(svg)}`;
  if (thumbnails.size >= CACHE_LIMIT) thumbnails.delete(thumbnails.keys().next().value);
  thumbnails.set(key, source);
  return source;
}
