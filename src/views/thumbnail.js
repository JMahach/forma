import { renderBodygraph } from '../scene/bodygraph-svg.js';
import { CHART_SURFACE_RIM_WIDTH } from '../scene/backdrop.js';
import { LOTUS_BACKDROP_BOUNDS } from '../scene/geometry/lotus-backdrop.js';
import { CENTERS } from '../scene/geometry/chart-geometry.js';

// SVG images isolate their styles and IDs from the interactive chart.
// Cache by activations, not names or birth data; repeated menu renders are cheap.
const thumbnails = new Map();
const CACHE_LIMIT = 100;
// Include the outer rim and a small antialiasing margin, without resizing cards.
const inset = CHART_SURFACE_RIM_WIDTH / 2 + 1;
const { x, y, width, height } = LOTUS_BACKDROP_BOUNDS;
const top = Math.min(y, ...CENTERS.flatMap(center => center.points.split(' ').map(point => Number(point.split(',')[1]))));
const viewBox = [x - inset, top - inset, width + inset * 2, y + height - top + inset * 2].join(' ');

export function renderChartThumbnail(chart) {
  const snapshot = { personality: chart.personality || [], design: chart.design || [] };
  const key = JSON.stringify(snapshot);
  if (thumbnails.has(key)) return thumbnails.get(key);
  const drawing = renderBodygraph(snapshot, null, {
    profile: 'thumbnail', idPrefix: 'thumbnail',
  });
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}">${drawing}</svg>`;
  const source = `data:image/svg+xml,${encodeURIComponent(svg)}`;
  if (thumbnails.size >= CACHE_LIMIT) thumbnails.delete(thumbnails.keys().next().value);
  thumbnails.set(key, source);
  return source;
}
