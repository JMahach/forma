import { MANDALA_PALETTE, MANDALA_OPACITY, mandalaGateSets, mandalaSectorPaint, mandalaPlanetEntries, mandalaPlanetPaint } from './mandala-paint-rules.js';
import { GATE_ORDER, normalizeLongitude } from '../domain/gate-wheel.js';
import { MANDALA_GEOMETRY, mandalaPoint, mandalaPointString as point, MANDALA_CENTER as center, MANDALA_SECTORS as sectors } from './geometry/mandala-geometry.js';
import { MANDALA_PLANET_LAYOUT, layoutMandalaPlanets } from './geometry/mandala-planets.js';

function planetMarkers(planets) {
  return planets.map(({ source, planet, longitude, leaderPath }) => {
      const paint = mandalaPlanetPaint(source, planet);
      const [x, y] = mandalaPoint(longitude, MANDALA_GEOMETRY.innerRadius);
      return `<g class="mandala-planet-marker" data-mandala-planet="${planet}" data-source="${source}" data-longitude="${longitude}">
        <path class="${paint.rayClass}" d="M ${center} L ${x} ${y}" fill="none" stroke="${paint.color}" stroke-opacity="${paint.rayOpacity}" stroke-width="${paint.rayWidth}"/>
        <circle class="mandala-planet-endpoint" cx="${x}" cy="${y}" r="${paint.radius}" fill="${paint.color}" fill-opacity="${paint.endpointOpacity}"/>
        <path class="mandala-planet-leader" d="${leaderPath}" fill="none" stroke="${paint.color}" stroke-opacity="${paint.leaderOpacity}" stroke-width="${paint.leaderWidth}"/>
      </g>`;
  }).join('');
}

function planetSymbols(planets) {
  return planets.map(({ source, planet, longitude, x, y, labelLongitude }) => {
    const paint = mandalaPlanetPaint(source, planet);
    return `<text class="mandala-planet-symbol" data-mandala-planet="${planet}" data-source="${source}" data-longitude="${longitude}" data-label-longitude="${labelLongitude}" x="${x}" y="${y}" fill="${paint.color}" font-size="${MANDALA_PLANET_LAYOUT.fontSize}" text-anchor="middle" dominant-baseline="central" stroke="${paint.symbolOutline}" stroke-width="${paint.symbolOutlineWidth}" stroke-linejoin="round" paint-order="stroke">${paint.symbol}</text>`;
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
  const gates = mandalaGateSets(chart);
  const planets = layoutMandalaPlanets(mandalaPlanetEntries(chart));
  const fields = [];
  const wheel = sectors.map(sector => {
    const { gate, start, middle, ring, fan, separator, label } = sector;
    const { state, related, pressed, color, textWeight, sources } = mandalaSectorPaint(sector, gates, selectedGates, relatedGates);
    fields.push(sources.map(source => `<path class="mandala-fan" data-mandala-gate="${gate}" data-mandala-source="${source.source}" d="${source.fan}" fill="${source.color}" fill-opacity="${MANDALA_OPACITY.fan}"/>`).join('')
      + (related ? `<path class="mandala-focus-sector" data-mandala-gate="${gate}" d="${fan}" fill="${MANDALA_PALETTE.highlight}" fill-opacity="${MANDALA_OPACITY.focus}"/>` : ''));
    const fills = sources.map(source => `<g class="mandala-source" data-mandala-source="${source.source}" fill="${source.color}" pointer-events="none">
      <path class="mandala-sector-fill" d="${source.ring}" fill-opacity="${MANDALA_OPACITY.sector}"/>
    </g>`).join('');
    const interaction = interactive ? ` data-type="gate" data-id="${gate}" role="button" tabindex="0" aria-label="Ворота ${gate}" aria-pressed="${pressed}"` : '';
    return `<g class="mandala-gate${interactive ? ' bg-interactive' : ''}" data-mandala-gate="${gate}" data-mandala-state="${state}" data-related="${related}" data-longitude-start="${normalizeLongitude(start)}" data-longitude-center="${normalizeLongitude(middle)}"${interaction}>
      ${fills}
      <path class="mandala-gate-highlight" d="${ring}" fill="${MANDALA_PALETTE.highlight}" fill-opacity="${MANDALA_OPACITY.highlight}" opacity="${related ? '1' : '0'}" pointer-events="none"/>
      <path class="mandala-separator" d="${separator}" fill="none" stroke="${MANDALA_PALETTE.rim}" stroke-opacity=".4" stroke-width=".75" pointer-events="none"/>
      <text class="mandala-number" x="${label[0]}" y="${label[1]}" fill="${color}" fill-opacity="1" font-size="12" font-weight="${textWeight}" text-anchor="middle" dominant-baseline="central" pointer-events="none">${gate}</text>
      ${interactive ? `<path class="mandala-gate-hit" d="${ring}" fill="transparent" pointer-events="all"/>` : ''}
    </g>`;
  }).join('');
  const { centerX: cx, centerY: cy, outerRadius: outer, innerRadius: inner, rayRadius } = MANDALA_GEOMETRY;
  return `<g class="bodygraph-mandala"${interactive ? '' : ' aria-hidden="true" pointer-events="none" focusable="false"'} font-family="Inter, -apple-system, BlinkMacSystemFont, sans-serif" style="font-variant-numeric: tabular-nums">
    <circle class="mandala-well" cx="${cx}" cy="${cy}" r="${outer}" fill="${MANDALA_PALETTE.paper}" fill-opacity=".1518" pointer-events="none"/>
    <g class="mandala-engraving-light" fill="none" stroke="${MANDALA_PALETTE.light}" stroke-opacity=".902" stroke-width="1" transform="translate(0 .65)" pointer-events="none" aria-hidden="true">
      <circle cx="${cx}" cy="${cy}" r="${outer}"/><circle cx="${cx}" cy="${cy}" r="${inner}"/><circle cx="${cx}" cy="${cy}" r="${rayRadius}"/>
    </g>
    <g class="mandala-field" pointer-events="none" aria-hidden="true">${fields.join('')}${planetMarkers(planets)}</g>
    ${wheel}
    ${pinnedCrosses.map(cross => renderCrossPreview(cross, { pinned: true })).join('')}
    ${pinnedCrosses.some(cross => cross.longitude === previewCross?.longitude && cross.source === previewCross?.source) ? '' : renderCrossPreview(previewCross)}
    <g class="mandala-engraving-edge" fill="none" stroke="${MANDALA_PALETTE.rim}" stroke-opacity=".3795" stroke-width=".65" pointer-events="none" aria-hidden="true">
      <circle cx="${cx}" cy="${cy}" r="${outer}"/><circle cx="${cx}" cy="${cy}" r="${inner}"/><circle cx="${cx}" cy="${cy}" r="${rayRadius}" stroke-opacity=".1771"/>
    </g>
    <g class="mandala-planet-labels" pointer-events="none" aria-hidden="true">${planetSymbols(planets)}</g>
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
