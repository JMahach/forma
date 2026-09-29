import { CENTERS, CHANNELS } from './geometry/chart-geometry.js';
import { roundedCenter, INTEGRATION_PATH } from './geometry/drawing-geometry.js';
import { ACTIVATION_COLUMN_LAYOUT, activationBlockTransform, activationRowY } from './geometry/activation-layout.js';
import { PLANETS } from '../domain/planets.js';
import { INTEGRATION_IDS } from '../domain/topology.js';
import { STUDIO_FRAME } from './geometry/frames.js';

// Prepared on the server/build, before any browser JavaScript. Reuse the real
// geometry, but omit numbers, activations, hit areas and interactive scene state.
export function renderLoadingPlaceholder() {
  const channels = CHANNELS.filter(channel => !INTEGRATION_IDS.has(channel.id)).map(channel => channel.path).join(' ');
  const centers = CENTERS.map(center => `<path d="${roundedCenter(center.points)}"/>`).join('');
  // The initial page opens transit: only the right activation column exists.
  // Saved birth charts keep both sources in the normal chart renderer.
  const columnX = ACTIVATION_COLUMN_LAYOUT.x.personality;
  const rows = PLANETS.map((_, index) => {
    const y = activationRowY(index) - 6;
    return `<circle cx="${columnX + 6}" cy="${y + 6}" r="6"/><rect x="${columnX + 24}" y="${y}" width="${index % 3 === 0 ? 43 : 34}" height="12" rx="6"/>`;
  }).join('');
  const columns = `<g transform="${activationBlockTransform('personality')}"><rect x="${columnX}" y="${ACTIVATION_COLUMN_LAYOUT.headingY - 11}" width="74" height="9" rx="4.5"/>${rows}</g>`;
  const { x, y, width, height } = STUDIO_FRAME.bounds;
  return `<svg id="chartLoadingArt" viewBox="${x} ${y} ${width} ${height}" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false"><g class="loading-columns">${columns}</g><path class="loading-channels" d="${channels} ${INTEGRATION_PATH}"/><g class="loading-centers">${centers}</g></svg>`;
}

export function prepareLoadingPage(html) {
  return html.replace('<!-- chart-loading-placeholder -->', renderLoadingPlaceholder());
}
