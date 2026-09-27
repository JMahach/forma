import { calculateVariables } from '../domain/variables.js';
import { activationBlockTransform } from './geometry/activation-layout.js';

// A separate, non-interactive layer within the existing drawing bounds.
// Arrow direction changes only the glyph, never the bodygraph geometry.
const SIDES = Object.freeze({
  design: { x: 148, color: '#c32d35', label: 'Дизайн', rule: 'M 24 88 H 198' },
  personality: { x: 492, color: '#202020', label: 'Личность', rule: 'M 437 88 H 582' },
});
const ROWS = Object.freeze({ top: 134, bottom: 206 });
const GLYPH_SCALE = 1.3;
const GLYPH_OFFSET = 36;
const ARROWS = Object.freeze({
  left: 'M19 -10H-2V-20L-21 0L-2 20V10H19Z',
  right: 'M-19 -10H2V-20L21 0L2 20V10H-19Z',
  up: 'M-10 19V-2H-20L0 -21L20 -2H10V19Z',
  down: 'M-10 -19V2H-20L0 21L20 2H10V-19Z',
});

export function renderVariableArrows(chart) {
  const variables = calculateVariables(chart);
  if (!variables.length || variables.some(variable => !ARROWS[variable.colorDirection])) return '';
  const headings = Object.entries(SIDES).map(([source, side]) => `<g class="variable-block" data-source="${source}" transform="${activationBlockTransform(source)}"><g class="bodygraph-variable-headings" data-source="${source}" fill="${side.color}" aria-hidden="true">
    <text class="activation-heading" x="${side.x - GLYPH_OFFSET}" y="76" text-anchor="middle" font-size="16" font-weight="500">Цвет</text>
    <text class="activation-heading" x="${side.x + GLYPH_OFFSET}" y="76" text-anchor="middle" font-size="16" font-weight="500">Тон</text>
    <path class="variable-header-rule" d="${side.rule}" fill="none" stroke="${side.color}" stroke-opacity=".18" stroke-width="1"/>
  </g></g>`).join('');
  return `<g class="bodygraph-variables" pointer-events="none" font-family="Inter, -apple-system, BlinkMacSystemFont, sans-serif" style="font-variant-numeric: tabular-nums">${headings}${variables.map(variable => {
    const side = SIDES[variable.source];
    const direction = variable.direction === 'left' ? 'влево' : 'вправо';
    const colorDirection = variable.colorDirection === 'up' ? 'вверх' : 'вниз';
    const label = `${side.label}: ${variable.label}, цвет ${variable.color} ${colorDirection}, тон ${variable.tone} ${direction}`;
    return `<g class="variable-block" data-source="${variable.source}" transform="${activationBlockTransform(variable.source)}"><g class="bodygraph-variable" data-variable="${variable.id}" data-source="${variable.source}" data-position="${variable.position}" data-direction="${variable.direction}" data-tone="${variable.tone}" data-color="${variable.color}" data-color-direction="${variable.colorDirection}" transform="translate(${side.x} ${ROWS[variable.position]})" role="img" aria-label="${label}">
      <title>${label}</title>
      <g class="variable-color" transform="translate(${-GLYPH_OFFSET} 0) scale(${GLYPH_SCALE})">
        <path d="${ARROWS[variable.colorDirection]}" fill="#ffffff" stroke="${side.color}" stroke-width="1.25" stroke-linejoin="round"/>
        <text x="0" y="${variable.colorDirection === 'up' ? 4 : -4}" text-anchor="middle" dominant-baseline="central" font-size="18" font-weight="500" fill="${side.color}">${variable.color}</text>
      </g>
      <g class="variable-tone" transform="translate(${GLYPH_OFFSET} 0) scale(${GLYPH_SCALE})">
        <path d="${ARROWS[variable.direction]}" fill="${side.color}" stroke="${side.color}" stroke-width="1.25" stroke-linejoin="round"/>
        <text x="${variable.direction === 'left' ? 4 : -4}" y="0" text-anchor="middle" dominant-baseline="central" font-size="18" font-weight="500" fill="#ffffff">${variable.tone}</text>
      </g>
    </g></g>`;
  }).join('')}</g>`;
}
