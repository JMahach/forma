import { renderChartBackdrop } from './backdrop.js';
import { CHART_BACKDROP_BOUNDS } from './geometry/chart-backdrop.js';

// The same softly rounded silhouette as the ordinary chart. Kept inside the
// fixed-size mandala-core, with translucency confined to this decorative group.
export const MANDALA_UNDERLAY_BOUNDS = CHART_BACKDROP_BOUNDS;

export function renderMandalaUnderlay(prefix = 'bodygraph', { lotus = false } = {}) {
  return renderChartBackdrop(prefix, { mandala: true, lotus });
}
