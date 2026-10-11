import { calculateVariables } from '../domain/variables.js';
import { isChartOverlay, primaryChart } from '../domain/chart-composition.js';
import { ACTIVATION_COLUMN_LAYOUT, activationBlockTransform, activationHeadingX } from './geometry/activation-layout.js';

// A separate, non-interactive layer within the existing drawing bounds.
// Arrow direction changes only the glyph, never the bodygraph geometry.
const SOURCE_PRESENTATION = Object.freeze({
  design: { columnSide: 'left', x: 148, color: '#c32d35', label: 'Дизайн', rule: `M ${activationHeadingX('left') + ACTIVATION_COLUMN_LAYOUT.headingWidths['Дизайн']} ${ACTIVATION_COLUMN_LAYOUT.ruleY} H 198` },
  personality: { columnSide: 'right', x: 492, color: '#202020', label: 'Личность', rule: `M 437 ${ACTIVATION_COLUMN_LAYOUT.ruleY} H ${activationHeadingX('right')}` },
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

export const visibleVariables = (chart, options) => options.showActivations && !options.showMandala && !isChartOverlay(chart) ? calculateVariables(primaryChart(chart)) : [];

// Persistent scenes pass the same domain snapshot they compared before drawing.
export function renderVariableArrows(chart, variables = isChartOverlay(chart) ? [] : calculateVariables(primaryChart(chart))) {
  if (!variables.length || variables.some(variable => !ARROWS[variable.colorDirection])) return '';
  const headings = Object.entries(SOURCE_PRESENTATION).map(([source, presentation]) => `<g class="variable-block" data-column-side="${presentation.columnSide}" transform="${activationBlockTransform(presentation.columnSide)}"><g class="bodygraph-variable-headings" data-source="${source}" fill="${presentation.color}" aria-hidden="true">
    <text class="activation-heading" x="${presentation.x - GLYPH_OFFSET}" y="${ACTIVATION_COLUMN_LAYOUT.headingY}" text-anchor="middle" font-size="16" font-weight="500">Цвет</text>
    <text class="activation-heading" x="${presentation.x + GLYPH_OFFSET}" y="${ACTIVATION_COLUMN_LAYOUT.headingY}" text-anchor="middle" font-size="16" font-weight="500">Тон</text>
    <path class="variable-header-rule" d="${presentation.rule}" fill="none" stroke="${presentation.color}" stroke-opacity=".18" stroke-width="1"/>
  </g></g>`).join('');
  return `<g class="bodygraph-variables" pointer-events="none" font-family="Inter, -apple-system, BlinkMacSystemFont, sans-serif" style="font-variant-numeric: tabular-nums">${headings}${variables.map(variable => {
    const presentation = SOURCE_PRESENTATION[variable.source];
    const direction = variable.direction === 'left' ? 'влево' : 'вправо';
    const colorDirection = variable.colorDirection === 'up' ? 'вверх' : 'вниз';
    const label = `${presentation.label}: ${variable.label}, цвет ${variable.color} ${colorDirection}, тон ${variable.tone} ${direction}`;
    return `<g class="variable-block" data-column-side="${presentation.columnSide}" transform="${activationBlockTransform(presentation.columnSide)}"><g class="bodygraph-variable" data-variable="${variable.id}" data-source="${variable.source}" data-position="${variable.position}" data-direction="${variable.direction}" data-tone="${variable.tone}" data-color="${variable.color}" data-color-direction="${variable.colorDirection}" transform="translate(${presentation.x} ${ROWS[variable.position]})" role="img" aria-label="${label}">
      <title>${label}</title>
      <g class="variable-color" transform="translate(${-GLYPH_OFFSET} 0) scale(${GLYPH_SCALE})">
        <path d="${ARROWS[variable.colorDirection]}" fill="#ffffff" stroke="${presentation.color}" stroke-width="1.25" stroke-linejoin="round"/>
        <text x="0" y="${variable.colorDirection === 'up' ? 4 : -4}" text-anchor="middle" dominant-baseline="central" font-size="18" font-weight="500" fill="${presentation.color}">${variable.color}</text>
      </g>
      <g class="variable-tone" transform="translate(${GLYPH_OFFSET} 0) scale(${GLYPH_SCALE})">
        <path d="${ARROWS[variable.direction]}" fill="${presentation.color}" stroke="${presentation.color}" stroke-width="1.25" stroke-linejoin="round"/>
        <text x="${variable.direction === 'left' ? 4 : -4}" y="0" text-anchor="middle" dominant-baseline="central" font-size="18" font-weight="500" fill="#ffffff">${variable.tone}</text>
      </g>
    </g></g>`;
  }).join('')}</g>`;
}
