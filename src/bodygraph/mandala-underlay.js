import { CHART_BACKDROP_BOUNDS, renderChartBackdrop } from './chart-backdrop.js';

// The same softly rounded silhouette as the ordinary chart. Kept inside the
// scaled mandala-core, with translucency confined to this decorative group.
export const MANDALA_UNDERLAY_BOUNDS = CHART_BACKDROP_BOUNDS;

export function renderMandalaUnderlay(prefix = 'bodygraph') {
  return renderChartBackdrop(prefix, { mandala: true });
}
