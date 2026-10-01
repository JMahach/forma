import { calculateLineFixings } from '../domain/line-fixing.js';
import { ACTIVATION_COLUMN_LAYOUT, ACTIVATION_PLANET_FILTER_LAYOUT, activationBlockTransform, activationHeadingX, activationRowY } from './geometry/activation-layout.js';

import { PLANETS } from '../domain/planets.js';

const FIXING_LABELS = {
  exalted: 'Экзальтация', detriment: 'Падение', juxtaposed: 'Экзальтация и падение'
};
const FIXING_SCALE = 1.15;

export const fixingPath = state => state === 'exalted' ? 'M -4 3 L 0 -4 L 4 3 Z'
  : state === 'detriment' ? 'M -4 -3 L 0 4 L 4 -3 Z'
    : state === 'juxtaposed' ? 'M -4 -1 L 0 -8 L 4 -1 Z M -4 1 L 0 8 L 4 1 Z' : '';

export function fixingMark(state) {
  if (!FIXING_LABELS[state]) return '';
  const path = fixingPath(state);
  // Kept outside the numeric button: its hit area and popover anchor stay intact.
  return `<g class="line-fixing" data-fixing="${state}" transform="translate(103 0) scale(${FIXING_SCALE})" pointer-events="none" aria-hidden="true"><path d="${path}"/></g>`;
}

const { centerX: filterX, size: filterSize, hitLeft: filterHitLeft, hitWidth: filterHitWidth } = ACTIVATION_PLANET_FILTER_LAYOUT;
export const planetFilterMark = checked => checked === 'mixed'
  ? `M ${filterX - 3.75} 0 H ${filterX + 3.75}` : `M ${filterX - 3.75} 0 L ${filterX - .75} 3 L ${filterX + 3.75} -3`;

// The checkbox has its own 28-unit target, with a clear gap before the glyph.
export function renderPlanetFilterControl(id, name, checked, transform = '') {
  return `<g class="activation-planet-filter" data-type="planet-filter" data-id="${id}" role="checkbox" aria-label="${name}" aria-checked="${checked}" tabindex="0"${transform ? ` transform="${transform}"` : ''}>
      <title>${name}</title>
      <rect class="activation-planet-filter-hit" x="${filterHitLeft}" y="-20" width="${filterHitWidth}" height="40" fill="transparent"/>
      <rect class="activation-planet-filter-frame" x="${filterX - filterSize / 2}" y="${-filterSize / 2}" width="${filterSize}" height="${filterSize}" rx="3.5" fill="#fffdf8" stroke="#b9b4a6" stroke-width="1" vector-effect="non-scaling-stroke" pointer-events="none"/>
      <path class="activation-planet-filter-mark" d="${planetFilterMark(checked)}" opacity="${checked === false ? 0 : 1}" fill="none" stroke="#fffef9" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" pointer-events="none"/>
    </g>`;
}

// Measure the rendered Sun number, not its button or the separate fixing mark.
// Relative SVG coordinates cancel the camera's zoom and pan.
export function alignPersonalityHeading(root) {
  const column = root.querySelector('.activation-column[data-source="personality"]');
  const heading = column?.querySelector('.activation-heading');
  const rule = column?.querySelector('.activation-header-rule');
  const value = column?.querySelector('[data-activation="personality-sun"] > text');
  if (heading?.textContent !== 'Личность' || !rule || !value) return;
  const columnMatrix = heading.getCTM(), valueMatrix = value.getCTM();
  if (!columnMatrix || !valueMatrix) return;
  const bounds = value.getBBox();
  if (!Number.isFinite(bounds.width) || bounds.width <= 0) return;
  const relative = columnMatrix.inverse().multiply(valueMatrix);
  const right = relative.a * (bounds.x + bounds.width) + relative.c * bounds.y + relative.e;
  const startX = activationHeadingX('personality');
  if (!Number.isFinite(right) || right <= startX) return;
  heading.setAttribute('x', String(right));
  heading.setAttribute('text-anchor', 'end');
  const headingBounds = heading.getBBox();
  const correction = right - (headingBounds.x + headingBounds.width);
  if (Number.isFinite(correction) && Math.abs(correction) > 1e-6) {
    heading.setAttribute('x', String(right + correction));
  }
  rule.setAttribute('d', `M ${startX} ${ACTIVATION_COLUMN_LAYOUT.ruleY} H ${right}`);
}

// Planetary values come exclusively from the saved calculation, never from
// the gate arrays of a manually entered chart.
export function describeActivationColumns(chart, selectedGates = new Set(), selection = null, { pressedGates = selectedGates, pressedSelection = selection, selections = [selection].filter(Boolean), pressedSelections = [pressedSelection].filter(Boolean), activationFilter = null, previewGates = new Set() } = {}) {
  if (!chart.activations && !chart.planetFilter?.activations && !chart.planetFilter?.designActivations) return [];
  const fixings = calculateLineFixings(chart);
  const planetFilter = chart.planetFilter;
  const filteredGroups = activationFilter?.groups || (activationFilter ? [activationFilter] : []);
  const unfilteredGates = new Set(activationFilter?.unfilteredGates || []);
  const columns = ['design', 'personality'].map(source => {
    const hasPlanetFilter = Boolean(planetFilter);
    const hasPlanetControl = hasPlanetFilter && planetFilter.perPlanetControls === true;
    const hasMasterControl = hasPlanetFilter && (source === 'design' || hasPlanetControl);
    const selectedPlanets = new Set((source === 'design' ? planetFilter?.selectedDesignPlanets : planetFilter?.selectedPlanets) || []);
    const filterPrefix = source === 'design' ? 'design:' : '';
    const entries = hasPlanetFilter ? (source === 'design' ? planetFilter.designActivations : planetFilter.activations) : chart.activations?.[source];
    if (!Array.isArray(entries) || !entries.length) return null;
    const x = ACTIVATION_COLUMN_LAYOUT.x[source];
    const label = source === 'design' ? 'Дизайн' : chart.source === 'transit' ? 'Транзит' : 'Личность';
    const color = source === 'design' ? '#c32d35' : '#202020';
    const rows = PLANETS.map(([planet, symbol, name], index) => {
      const entry = entries.find(item => item.planet === planet);
      if (!entry || !Number.isInteger(entry.gate) || entry.gate < 1 || entry.gate > 64 || !Number.isInteger(entry.line) || entry.line < 1 || entry.line > 6) return null;
      // A summary line selects exact activation rows; graph selections still
      // operate on unique gates. Hover adds its usual gate copies temporarily.
      const matchesFilter = !activationFilter || unfilteredGates.has(entry.gate)
        || filteredGroups.some(group => entry.line === group.line
          && (group.source === 'all' || group.source === source)
          && (!group.gates || group.gates.includes(entry.gate)));
      const planetEnabled = !hasPlanetFilter || selectedPlanets.has(planet);
      const selected = selectedGates.has(entry.gate) && matchesFilter || previewGates.has(entry.gate);
      const pressed = pressedGates.has(entry.gate) && matchesFilter;
      const fixing = planetEnabled ? fixings.get(`${source}-${planet}`)?.state : undefined;
      const fixingLabel = FIXING_LABELS[fixing];
      const planetSelected = selections.some(value => value.type === 'planet' && value.id === `${source}-${planet}`);
      const id = `${source}-${planet}`;
      return { id, source, planet, symbol, name, x, y: activationRowY(index), label,
        gate: entry.gate, line: entry.line, selected, pressed, fixing, fixingLabel, planetSelected, hasPlanetControl, planetEnabled, filterId: `${filterPrefix}${planet}`,
        planetPressed: pressedSelections.some(value => value.type === 'planet' && value.id === id),
        planetAria: `${label}, ${name}`, planetTitle: `${name} · ${label}`,
        gateAria: `${label}, ${name}: ворота ${entry.gate}, линия ${entry.line}${fixingLabel ? `, ${fixingLabel.toLowerCase()}` : ''}`,
        gateTitle: `Ворота ${entry.gate} · линия ${entry.line}${fixingLabel ? ` · ${fixingLabel}` : ''}`,
      };
    }).filter(Boolean);
    const enabledCount = PLANETS.filter(([planet]) => selectedPlanets.has(planet)).length;
    return { source, x, label, color, rows, hasMasterControl, filterId: `${filterPrefix}all`,
      allPlanetsChecked: enabledCount === PLANETS.length ? true : enabledCount ? 'mixed' : false,
      transform: activationBlockTransform(source), headingWidth: ACTIVATION_COLUMN_LAYOUT.headingWidths[label] };
  }).filter(Boolean);
  return columns;
}

export function renderActivationRow(row) {
  const { id, symbol, x, y, gate, line, selected, pressed, fixing, planetSelected, planetPressed, planetAria, planetTitle, gateAria, gateTitle, hasPlanetControl, filterId, planetEnabled = true } = row;
  return `<g class="activation-row" transform="translate(${x} ${y})">
        ${hasPlanetControl ? renderPlanetFilterControl(filterId, planetAria, planetEnabled) : ''}
        <g class="bg-activation bg-planet" data-type="planet" data-id="${id}" data-activation="${id}-planet" tabindex="0" role="button" aria-label="${planetAria}" aria-pressed="${planetPressed}"${planetEnabled ? '' : ' opacity=".35"'}>
          <title>${planetTitle}</title>
          <rect x="-8" y="-20" width="32" height="40" rx="5" fill="${planetSelected ? '#eaf0f8' : 'transparent'}"/>
          <text class="planet-symbol" x="${ACTIVATION_COLUMN_LAYOUT.glyphOffsetX}" y="0" text-anchor="middle" dominant-baseline="central" font-size="26" pointer-events="none">${symbol}</text>
        </g>
        <g class="bg-activation" data-type="gate" data-id="${gate}" data-activation="${id}" data-selected="${selected}" tabindex="0" role="button" aria-label="${gateAria}" aria-pressed="${pressed}"${planetEnabled ? '' : ' opacity=".22"'}>
          <title>${gateTitle}</title>
          <rect x="28" y="-20" width="68" height="40" rx="5" fill="${selected ? '#eaf0f8' : 'transparent'}"/>
          <text x="${ACTIVATION_COLUMN_LAYOUT.valueOffsetX}" y="0" dominant-baseline="central" font-size="24" font-weight="500" pointer-events="none">${gate}<tspan font-weight="400" opacity=".7">.${line}</tspan></text>
        </g>
        ${fixingMark(fixing)}
      </g>`;
}

export function renderActivationColumn(column) {
  const { source, x, label, color, transform, headingWidth, rows, hasMasterControl, filterId, allPlanetsChecked } = column;
  return `<g class="activation-column" data-source="${source}" fill="${color}" font-family="Inter, -apple-system, BlinkMacSystemFont, sans-serif" style="font-variant-numeric: tabular-nums">
      <g class="activation-block-content" transform="${transform}">
      <text class="activation-heading" x="${activationHeadingX(source)}" y="${ACTIVATION_COLUMN_LAYOUT.headingY}" font-size="16" font-weight="500">${label}</text>
      <path class="activation-header-rule" d="M ${activationHeadingX(source)} ${ACTIVATION_COLUMN_LAYOUT.ruleY} h ${headingWidth}" stroke="${color}" stroke-opacity=".18" stroke-width="1" fill="none"/>
      ${hasMasterControl ? renderPlanetFilterControl(filterId, `${label}, все планеты`, allPlanetsChecked, `translate(${x} ${ACTIVATION_COLUMN_LAYOUT.headingY - 6})`) : ''}
      ${rows.map(renderActivationRow).join('')}
      </g>
    </g>`;
}

export function renderActivationColumns(chart, selectedGates = new Set(), selection = null, options = {}) {
  const columns = describeActivationColumns(chart, selectedGates, selection, options);
  return columns.length ? `<g class="activation-columns">${columns.map(renderActivationColumn).join('')}</g>` : '';
}
