import { LOTUS_SILHOUETTE_PATH, LOTUS_DETAIL_PATHS } from './geometry/lotus-backdrop.js';

// A free-standing, softly rounded backing behind the bodygraph, rather than a
// tight offset of every center. It never extends beneath activation columns.
// Painting the fill over a centered stroke leaves a constant-width outer rim.
// Only the complete mandala surface is translucent; channels/centers are not.
export const CHART_SURFACE = Object.freeze({ top: '#f8f7f3', middle: '#f2f0ea', bottom: '#eeece5', edge: '#e1ded5' });
export const CHART_SURFACE_RIM_WIDTH = 6;
export const CHART_MANDALA_SURFACE_OPACITY = .68;

export function renderChartBackdrop(prefix = 'bodygraph', { mandala = false } = {}) {
  const safePrefix = String(prefix).replace(/[^a-zA-Z0-9_-]/g, '') || 'bodygraph';
  const id = `${safePrefix}-${mandala ? 'mandala-porcelain' : 'chart-backdrop'}`;
  const className = mandala ? 'mandala-underlay' : 'chart-backdrop';
  return `<g class="${className}" pointer-events="none" aria-hidden="true" focusable="false"${mandala ? ` opacity="${CHART_MANDALA_SURFACE_OPACITY}"` : ''}><defs><linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${CHART_SURFACE.top}"/><stop offset=".5" stop-color="${CHART_SURFACE.middle}"/><stop offset="1" stop-color="${CHART_SURFACE.bottom}"/></linearGradient></defs><path class="chart-surface-rim" d="${LOTUS_SILHOUETTE_PATH}" fill="none" stroke="${CHART_SURFACE.edge}" stroke-width="${CHART_SURFACE_RIM_WIDTH}" stroke-linejoin="round"/><path class="chart-surface-inset" d="${LOTUS_SILHOUETTE_PATH}" fill="url(#${id})" fill-rule="evenodd" stroke="none"/><g class="lotus-contours" fill="none" stroke="#d2cdc1" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${LOTUS_DETAIL_PATHS.map(path => `<path d="${path}"/>`).join('')}</g></g>`;
}
