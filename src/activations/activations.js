import { calculateLineFixings } from './line-fixing.js';

export const PLANETS = [
  ['sun', '☉', 'Солнце'], ['earth', '⊕', 'Земля'], ['moon', '☽', 'Луна'],
  ['north_node', '☊', 'Северный узел'], ['south_node', '☋', 'Южный узел'],
  ['mercury', '☿', 'Меркурий'], ['venus', '♀', 'Венера'], ['mars', '♂', 'Марс'],
  ['jupiter', '♃', 'Юпитер'], ['saturn', '♄', 'Сатурн'], ['uranus', '♅', 'Уран'],
  ['neptune', '♆', 'Нептун'], ['pluto', '♇', 'Плутон']
];

const FIXING_LABELS = {
  exalted: 'Экзальтация', detriment: 'Падение', juxtaposed: 'Экзальтация и падение'
};
const FIXING_SCALE = 1.15;
const HEADING_WIDTHS = { 'Дизайн': 58, 'Личность': 74, 'Транзит': 58 };

function fixingMark(state) {
  if (!FIXING_LABELS[state]) return '';
  const path = state === 'exalted' ? 'M -4 3 L 0 -4 L 4 3 Z'
    : state === 'detriment' ? 'M -4 -3 L 0 4 L 4 -3 Z'
      : 'M -4 -1 L 0 -8 L 4 -1 Z M -4 1 L 0 8 L 4 1 Z';
  // Kept outside the numeric button: its hit area and popover anchor stay intact.
  return `<g class="line-fixing" data-fixing="${state}" transform="translate(103 0) scale(${FIXING_SCALE})" pointer-events="none" aria-hidden="true"><path d="${path}"/></g>`;
}

// Measure the rendered Sun number, not its button or the separate fixing mark.
// Relative SVG coordinates cancel the camera's zoom and pan.
export function alignPersonalityHeading(root) {
  const column = root.querySelector('.activation-column[data-source="personality"]');
  const heading = column?.querySelector('.activation-heading');
  const rule = column?.querySelector('.activation-header-rule');
  const value = column?.querySelector('[data-activation="personality-sun"] > text');
  if (heading?.textContent !== 'Личность' || !rule || !value) return;
  const columnMatrix = column.getCTM(), valueMatrix = value.getCTM();
  if (!columnMatrix || !valueMatrix) return;
  const bounds = value.getBBox();
  if (!Number.isFinite(bounds.width) || bounds.width <= 0) return;
  const relative = columnMatrix.inverse().multiply(valueMatrix);
  const right = relative.a * (bounds.x + bounds.width) + relative.c * bounds.y + relative.e;
  if (!Number.isFinite(right) || right <= 582) return;
  heading.setAttribute('x', String(right));
  heading.setAttribute('text-anchor', 'end');
  const headingBounds = heading.getBBox();
  const correction = right - (headingBounds.x + headingBounds.width);
  if (Number.isFinite(correction) && Math.abs(correction) > 1e-6) {
    heading.setAttribute('x', String(right + correction));
  }
  rule.setAttribute('d', `M 582 88 H ${right}`);
}

// Planetary values come exclusively from the saved calculation, never from
// the gate arrays of a manually entered chart.
export function renderActivationColumns(chart, selectedGates = new Set(), selection = null, { pressedGates = selectedGates, pressedSelection = selection, selections = [selection].filter(Boolean), pressedSelections = [pressedSelection].filter(Boolean) } = {}) {
  if (!chart.activations) return '';
  const fixings = calculateLineFixings(chart);
  const columns = ['design', 'personality'].map(source => {
    const entries = chart.activations[source];
    if (!Array.isArray(entries) || !entries.length) return '';
    const x = source === 'design' ? -32 : 584;
    const label = source === 'design' ? 'Дизайн' : chart.source === 'transit' ? 'Транзит' : 'Личность';
    const color = source === 'design' ? '#c32d35' : '#202020';
    const rows = PLANETS.map(([planet, symbol, name], index) => {
      const entry = entries.find(item => item.planet === planet);
      if (!entry || !Number.isInteger(entry.gate) || entry.gate < 1 || entry.gate > 64 || !Number.isInteger(entry.line) || entry.line < 1 || entry.line > 6) return '';
      const selected = selectedGates.has(entry.gate);
      const fixing = fixings.get(`${source}-${planet}`)?.state;
      const fixingLabel = FIXING_LABELS[fixing];
      const planetSelected = selections.some(value => value.type === 'planet' && value.id === `${source}-${planet}`);
      return `<g class="activation-row" transform="translate(${x} ${118 + index * 48})">
        <g class="bg-activation bg-planet" data-type="planet" data-id="${source}-${planet}" data-activation="${source}-${planet}-planet" tabindex="0" role="button" aria-label="${label}, ${name}" aria-pressed="${pressedSelections.some(value => value.type === 'planet' && value.id === `${source}-${planet}`)}">
          <title>${name} · ${label}</title>
          <rect x="-8" y="-20" width="32" height="40" rx="5" fill="${planetSelected ? '#eaf0f8' : 'transparent'}"/>
          <text class="planet-symbol" x="8" y="0" text-anchor="middle" dominant-baseline="central" font-size="26" pointer-events="none">${symbol}</text>
        </g>
        <g class="bg-activation" data-type="gate" data-id="${entry.gate}" data-activation="${source}-${planet}" data-selected="${selected}" tabindex="0" role="button" aria-label="${label}, ${name}: ворота ${entry.gate}, линия ${entry.line}${fixingLabel ? `, ${fixingLabel.toLowerCase()}` : ''}" aria-pressed="${pressedGates.has(entry.gate)}">
          <title>Ворота ${entry.gate} · линия ${entry.line}${fixingLabel ? ` · ${fixingLabel}` : ''}</title>
          <rect x="28" y="-20" width="68" height="40" rx="5" fill="${selected ? '#eaf0f8' : 'transparent'}"/>
          <text x="34" y="0" dominant-baseline="central" font-size="24" font-weight="500" pointer-events="none">${entry.gate}<tspan font-weight="400" opacity=".7">.${entry.line}</tspan></text>
        </g>
        ${fixingMark(fixing)}
      </g>`;
    }).join('');
    return `<g class="activation-column" data-source="${source}" fill="${color}" font-family="Inter, -apple-system, BlinkMacSystemFont, sans-serif" style="font-variant-numeric: tabular-nums">
      <text class="activation-heading" x="${x - 2}" y="76" font-size="16" font-weight="500">${label}</text>
      <path class="activation-header-rule" d="M ${x - 2} 88 h ${HEADING_WIDTHS[label]}" stroke="${color}" stroke-opacity=".18" stroke-width="1" fill="none"/>
      ${rows}
    </g>`;
  }).join('');
  return columns ? `<g class="activation-columns">${columns}</g>` : '';
}
