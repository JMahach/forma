import { CENTERS, CHANNELS } from './geometry/chart-geometry.js';
import { roundedCenter, INTEGRATION_PATH } from './geometry/drawing-geometry.js';
import { ACTIVATION_COLUMN_LAYOUT, activationBlockTransform, activationHeadingX, activationRowY } from './geometry/activation-layout.js';
import { PLANETS } from '../domain/planets.js';
import { INTEGRATION_IDS } from '../domain/topology.js';
import { MANDALA_GEOMETRY, MANDALA_SCENE_TRANSFORM, MANDALA_SECTORS } from './geometry/mandala-geometry.js';
import { DRAWING_TRANSFORM, CHANNEL_WIDTH } from './geometry/drawing-presentation.js';

// Prepared on the server/build, before any browser JavaScript. Reuse the real
// geometry, but omit numbers, activations, hit areas and interactive scene state.
export function renderLoadingPlaceholder() {
  const channels = CHANNELS.filter(channel => !INTEGRATION_IDS.has(channel.id)).map(channel => channel.path).join(' ');
  const centers = CENTERS.map(center => `<path d="${roundedCenter(center.points)}"/>`).join('');
  // Both transit sources keep their rows visible, including unchecked Design.
  // The shared column classes apply the same resting gap as the loaded chart.
  const columns = [['left', 'Дизайн'], ['right', 'Транзит']].map(([columnSide, label]) => {
    const x = ACTIVATION_COLUMN_LAYOUT.x[columnSide];
    const rows = PLANETS.map((_, index) => {
      const y = activationRowY(index);
      return `<g class="loading-activation-row" transform="translate(${x} ${y})"><circle cx="${ACTIVATION_COLUMN_LAYOUT.glyphOffsetX}" cy="0" r="6"/><rect x="${ACTIVATION_COLUMN_LAYOUT.valueOffsetX}" y="-6" width="${index % 3 === 0 ? 43 : 34}" height="12" rx="6"/></g>`;
    }).join('');
    return `<g class="activation-column" data-column-side="${columnSide}"><g class="activation-block-content" transform="${activationBlockTransform(columnSide)}"><rect x="${activationHeadingX(columnSide)}" y="${ACTIVATION_COLUMN_LAYOUT.headingY - 11}" width="${ACTIVATION_COLUMN_LAYOUT.headingWidths[label]}" height="9" rx="4.5"/>${rows}</g></g>`;
  }).join('');
  const { centerX, centerY, outerRadius, innerRadius, rayRadius } = MANDALA_GEOMETRY;
  const rings = [outerRadius, innerRadius, rayRadius].map(radius => `<circle cx="${centerX}" cy="${centerY}" r="${radius}" stroke-width=".65"/>`).join('');
  const separators = MANDALA_SECTORS.map(sector => `<path d="${sector.separator}" stroke-width=".75"/>`).join('');
  const mandala = `<g class="mandala-scene" transform="${MANDALA_SCENE_TRANSFORM}"><g class="bodygraph-mandala loading-mandala">${rings}${separators}</g></g>`;
  return `<svg id="chartLoadingArt" viewBox="0 0 640 820" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false">${mandala}<g class="bodygraph-drawing" transform="${DRAWING_TRANSFORM}"><g class="loading-columns">${columns}</g><path class="loading-channels" stroke-width="${CHANNEL_WIDTH.outline}" d="${channels} ${INTEGRATION_PATH}"/><g class="loading-centers">${centers}</g></g></svg>`;
}

export function prepareLoadingPage(html) {
  return html.replace('<!-- chart-loading-placeholder -->', () => renderLoadingPlaceholder());
}
