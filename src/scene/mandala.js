import { PLANETS } from '../domain/planets.js';
import { GATE_ORDER, GATE_LONGITUDE_START, GATE_WIDTH, normalizeLongitude, gatePositionAtLongitude } from '../domain/gate-wheel.js';
import { MANDALA_GEOMETRY, mandalaPoint, mandalaPointString as point, MANDALA_CENTER as center, sectorPath, MANDALA_SECTORS as sectors } from './geometry/mandala-geometry.js';

export const MANDALA_PALETTE = Object.freeze({
  paper: '#eee8dc', rim: '#a59c8d', light: '#ffffff', empty: '#8e897e',
  design: '#b6756a', personality: '#727975', both: '#807b73',
  highlight: '#c4d9f1',
});
const gateSet = values => new Set((Array.isArray(values) ? values : [])
  .map(Number).filter(gate => Number.isInteger(gate) && gate >= 1 && gate <= 64));

export function mandalaPlanetEntries(chart) {
  if (!['calculated', 'transit'].includes(chart?.source)) return [];
  return ['design', 'personality'].flatMap(source => {
    if (source === 'design' && chart.source === 'transit') return [];
    const entries = chart.activations?.[source];
    if (!Array.isArray(entries)) return [];
    return PLANETS.flatMap(([planet]) => {
      const matches = entries.filter(entry => entry?.planet === planet);
      if (matches.length !== 1) return [];
      const entry = matches[0];
      if (!Number.isFinite(entry.longitude) || entry.longitude < 0 || entry.longitude >= 360) return [];
      const position = gatePositionAtLongitude(entry.longitude);
      if (entry.gate !== position.gate || entry.line !== position.line) return [];
      return [{ source, planet, longitude: entry.longitude }];
    });
  });
}

function planetMarkers(chart) {
  return mandalaPlanetEntries(chart).map(({ source, planet, longitude }) => {
      // A ray represents the exact saved position, not the middle of its gate.
      // Both sources meet the same ring; offsetting either would imply a false
      // position. Sun/Earth are distinguished only by emphasis, not geometry.
      const cross = planet === 'sun' || planet === 'earth';
      const [x, y] = mandalaPoint(longitude, MANDALA_GEOMETRY.innerRadius);
      return `<g class="mandala-planet-marker" data-mandala-planet="${planet}" data-source="${source}" data-longitude="${longitude}">
        <path class="mandala-planet-ray${cross ? ' mandala-cross-axis' : ''}" d="M ${center} L ${x} ${y}" fill="none" stroke="${MANDALA_PALETTE[source]}" stroke-opacity="${cross ? '.5313' : '.2783'}" stroke-width="${cross ? '.8' : '.55'}"/>
        <circle class="mandala-planet-endpoint" cx="${x}" cy="${y}" r="${cross ? '1.35' : '.85'}" fill="${MANDALA_PALETTE[source]}" fill-opacity="${cross ? '1' : '.759'}"/>
      </g>`;
  }).join('');
}

/**
 * SVG wheel behind the existing bodygraph and camera, using the same gate sets.
 * Only the outer annular gate cells are interactive. Their ordinary gate targets
 * reuse the parent's selection, Shift and preview logic; rays never capture it.
 * selectedGates is committed state, relatedGates includes the temporary preview.
 * The renderer has no local selection state, IDs, calculation or storage.
 */
export function renderMandala(chart = {}, { interactive = true, selectedGates = new Set(), relatedGates = selectedGates, previewCross = null, pinnedCrosses = [] } = {}) {
  const personality = gateSet(chart?.personality), design = gateSet(chart?.design);
  const fields = [];
  const wheel = sectors.map(sector => {
    const { gate, start, middle, ring, halfRings, fan, halfFans, separator, label } = sector;
    const hasPersonality = personality.has(gate), hasDesign = design.has(gate);
    const state = hasPersonality && hasDesign ? 'both' : hasDesign ? 'design' : hasPersonality ? 'personality' : 'empty';
    const active = state !== 'empty';
    const sources = state === 'both' ? ['design', 'personality'] : active ? [state] : [];
    const related = relatedGates.has(gate), pressed = selectedGates.has(gate);
    fields.push(sources.map((source, index) => `<path class="mandala-fan" data-mandala-gate="${gate}" data-mandala-source="${source}" d="${state === 'both' ? halfFans[index] : fan}" fill="${MANDALA_PALETTE[source]}" fill-opacity=".082225"/>`).join('')
      + (related ? `<path class="mandala-focus-sector" data-mandala-gate="${gate}" d="${fan}" fill="${MANDALA_PALETTE.highlight}" fill-opacity=".242"/>` : ''));
    const fills = sources.map((source, index) => `<g class="mandala-source" data-mandala-source="${source}" fill="${MANDALA_PALETTE[source]}" pointer-events="none">
      <path class="mandala-sector-fill" d="${state === 'both' ? halfRings[index] : ring}" fill-opacity=".25"/>
    </g>`).join('');
    const interaction = interactive ? ` data-type="gate" data-id="${gate}" role="button" tabindex="0" aria-label="Ворота ${gate}" aria-pressed="${pressed}"` : '';
    return `<g class="mandala-gate${interactive ? ' bg-interactive' : ''}" data-mandala-gate="${gate}" data-mandala-state="${state}" data-related="${related}" data-longitude-start="${normalizeLongitude(start)}" data-longitude-center="${normalizeLongitude(middle)}"${interaction}>
      ${fills}
      <path class="mandala-gate-highlight" d="${ring}" fill="${MANDALA_PALETTE.highlight}" fill-opacity=".77" opacity="${related ? '1' : '0'}" pointer-events="none"/>
      <path class="mandala-separator" d="${separator}" fill="none" stroke="${MANDALA_PALETTE.rim}" stroke-opacity=".4" stroke-width=".75" pointer-events="none"/>
      <text class="mandala-number" x="${label[0]}" y="${label[1]}" fill="${MANDALA_PALETTE[state]}" fill-opacity="1" font-size="12" font-weight="${active ? '600' : '400'}" text-anchor="middle" dominant-baseline="central" pointer-events="none">${gate}</text>
      ${interactive ? `<path class="mandala-gate-hit" d="${ring}" fill="transparent" pointer-events="all"/>` : ''}
    </g>`;
  }).join('');
  const { centerX: cx, centerY: cy, outerRadius: outer, innerRadius: inner, rayRadius } = MANDALA_GEOMETRY;
  return `<g class="bodygraph-mandala"${interactive ? '' : ' aria-hidden="true" pointer-events="none" focusable="false"'} font-family="Inter, -apple-system, BlinkMacSystemFont, sans-serif" style="font-variant-numeric: tabular-nums">
    <circle class="mandala-well" cx="${cx}" cy="${cy}" r="${outer}" fill="${MANDALA_PALETTE.paper}" fill-opacity=".1518" pointer-events="none"/>
    <g class="mandala-engraving-light" fill="none" stroke="${MANDALA_PALETTE.light}" stroke-opacity=".902" stroke-width="1" transform="translate(0 .65)" pointer-events="none" aria-hidden="true">
      <circle cx="${cx}" cy="${cy}" r="${outer}"/><circle cx="${cx}" cy="${cy}" r="${inner}"/><circle cx="${cx}" cy="${cy}" r="${rayRadius}"/>
    </g>
    <g class="mandala-field" pointer-events="none" aria-hidden="true">${fields.join('')}${planetMarkers(chart)}</g>
    ${wheel}
    ${pinnedCrosses.map(cross => renderCrossPreview(cross, { pinned: true })).join('')}
    ${pinnedCrosses.some(cross => cross.longitude === previewCross?.longitude && cross.source === previewCross?.source) ? '' : renderCrossPreview(previewCross)}
    <g class="mandala-engraving-edge" fill="none" stroke="${MANDALA_PALETTE.rim}" stroke-opacity=".3795" stroke-width=".65" pointer-events="none" aria-hidden="true">
      <circle cx="${cx}" cy="${cy}" r="${outer}"/><circle cx="${cx}" cy="${cy}" r="${inner}"/><circle cx="${cx}" cy="${cy}" r="${rayRadius}" stroke-opacity=".1771"/>
    </g>
  </g>`;
}

// Separate selection layers: original planetary rays and chart activations
// never move. Angle categories describe profiles, not a mirrored solar arc.
export function renderCrossPreview(cross, { pinned = false } = {}) {
  if (!['right-angle', 'juxtaposition', 'left-angle'].includes(cross?.type)
    || !Array.isArray(cross.positions) || cross.positions.length !== 4) return '';
  const colors = { design: '#ae6259', personality: '#4b514e' };
  if (!cross.positions.every(p => p && ['design', 'personality'].includes(p.source)
    && ['sun', 'earth'].includes(p.planet) && Number.isFinite(p.longitude)
    && p.longitude >= 0 && p.longitude < 360 && GATE_ORDER.includes(p.gate))) return '';
  if (new Set(cross.positions.map(p => `${p.source}-${p.planet}`)).size !== 4) return '';
  if (cross.source !== undefined && !['personality', 'design'].includes(cross.source)) return '';
  const marks = cross.positions.map(p => {
    const sector = sectors.find(s => s.gate === p.gate);
    const [x, y] = mandalaPoint(p.longitude, MANDALA_GEOMETRY.innerRadius);
    return `<g class="mandala-cross-position" data-cross-gate="${p.gate}" data-source="${p.source}" data-cross-planet="${p.planet}" data-longitude="${p.longitude}">
      <path class="mandala-cross-sector" d="${sector.ring}" fill="${colors[p.source]}" fill-opacity=".15" stroke="${colors[p.source]}" stroke-opacity=".7" stroke-width=".8"/>
      <path class="mandala-cross-preview-ray" d="M ${center} L ${x} ${y}" fill="none" stroke="${colors[p.source]}" stroke-opacity=".85" stroke-width="1.45"/>
      <circle cx="${x}" cy="${y}" r="2.5" fill="${colors[p.source]}"/>
    </g>`;
  }).join('');
  const cursor = cross.positions.find(p => p.source === (cross.source || 'personality') && p.planet === 'sun');
  const indicator = `<path class="mandala-cross-cursor" d="M ${point(cursor.longitude, MANDALA_GEOMETRY.outerRadius - 3)} L ${point(cursor.longitude, MANDALA_GEOMETRY.outerRadius + 6)}" fill="none" stroke="${colors[cursor.source]}" stroke-width="2" stroke-linecap="round"/>`;
  return `<g class="${pinned ? 'mandala-cross-pinned' : 'mandala-cross-preview'}" data-cross-type="${cross.type}" pointer-events="none" aria-hidden="true">${marks}${indicator}</g>`;
}
