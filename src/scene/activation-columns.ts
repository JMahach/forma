import type { ChartInput, ChartView } from '../domain/chart-composition.ts';
import type { SelectionTarget } from '../selection/selection-targets.ts';
import type { ColumnSide } from './geometry/activation-layout.ts';
export interface ColumnSelectionOptions {
  pressedGates?: ReadonlySet<number>;
  pressedSelection?: SelectionTarget | null;
  selections?: readonly SelectionTarget[];
  pressedSelections?: readonly SelectionTarget[];
  previewGates?: ReadonlySet<number>;
  showMandala?: boolean;
}
export type ActivationColumn = ReturnType<typeof describeActivationColumns>[number];
export type ActivationRow = ActivationColumn['rows'][number];

import { describePlanetTarget, renderPlanetTarget } from './activation-targets.ts';
import { renderOverlayActivationColumns } from './overlay-activation-columns.ts';
import { isChartOverlay, primaryChart } from '../domain/chart-composition.ts';
import { calculateLineFixings } from '../domain/line-fixing.ts';
import { ACTIVATION_COLUMN_LAYOUT, ACTIVATION_ROW_LAYOUT, ACTIVATION_PLANET_FILTER_LAYOUT, activationTargetLayout, activationPlanetLayout, activationBlockTransform, activationHeadingX, activationRowY } from './geometry/activation-layout.ts';

import { PLANETS } from '../domain/planets.ts';

const FIXING_LABELS = {
  exalted: 'Экзальтация', detriment: 'Падение', juxtaposed: 'Экзальтация и падение'
};
const FIXING_SCALE = 1.15;

// Initial SVG and persistent columns share one bounded snapshot of chart facts.
// Hover/selection changes paint only; compare values to also observe in-place
// edits and transit filtering without retaining caller-owned activation rows.
let fixingSnapshot: (readonly [string, number, number])[][] | null = null;
let cachedFixings: ReturnType<typeof calculateLineFixings> | null = null;
function lineFixingsFor(chart: ChartInput) {
  const sources = (['design', 'personality'] as const).map(source =>
    Array.isArray(chart.activations?.[source]) ? chart.activations[source] : []);
  const changed = !fixingSnapshot || sources.some((entries, source) => entries.length !== fixingSnapshot![source].length
    || entries.some((entry, index) => {
      const previous = fixingSnapshot![source][index];
      return !Object.is(entry?.planet, previous[0]) || !Object.is(entry?.gate, previous[1]) || !Object.is(entry?.line, previous[2]);
    }));
  if (changed) {
    cachedFixings = calculateLineFixings(chart);
    fixingSnapshot = sources.map(entries => entries.map(entry => [entry?.planet, entry?.gate, entry?.line]));
  }
  return cachedFixings!;
}

export const fixingPath = (state: string | undefined) => state === 'exalted' ? 'M -4 3 L 0 -4 L 4 3 Z'
  : state === 'detriment' ? 'M -4 -3 L 0 4 L 4 -3 Z'
    : state === 'juxtaposed' ? 'M -4 -1 L 0 -8 L 4 -1 Z M -4 1 L 0 8 L 4 1 Z' : '';

export function fixingMark(state: string | undefined) {
  if (!FIXING_LABELS[state as keyof typeof FIXING_LABELS]) return '';
  const path = fixingPath(state);
  // Kept outside the numeric button: its hit area and popover anchor stay intact.
  return `<g class="line-fixing" data-fixing="${state}" transform="translate(103 0) scale(${FIXING_SCALE})" pointer-events="none" aria-hidden="true"><path d="${path}"/></g>`;
}

const { centerX: filterX, size: filterSize, hitLeft: filterHitLeft, hitWidth: filterHitWidth } = ACTIVATION_PLANET_FILTER_LAYOUT;
export const planetFilterMark = (checked: boolean | 'mixed') => checked === 'mixed'
  ? `M ${filterX - 3.75} 0 H ${filterX + 3.75}` : `M ${filterX - 3.75} 0 L ${filterX - .75} 3 L ${filterX + 3.75} -3`;

// The checkbox has its own 28-unit target, with a clear gap before the glyph.
export function renderPlanetFilterControl(id: string, name: string, checked: boolean | 'mixed', transform = '') {
  return `<g class="activation-planet-filter" data-type="planet-filter" data-id="${id}" role="checkbox" aria-label="${name}" aria-checked="${checked}" tabindex="0"${transform ? ` transform="${transform}"` : ''}>
      <rect class="activation-planet-filter-hit" x="${filterHitLeft}" y="-20" width="${filterHitWidth}" height="40" fill="transparent"/>
      <rect class="activation-planet-filter-frame" x="${filterX - filterSize / 2}" y="${-filterSize / 2}" width="${filterSize}" height="${filterSize}" rx="3.5" fill="#fffdf8" stroke="#b9b4a6" stroke-width="1" vector-effect="non-scaling-stroke" pointer-events="none"/>
      <path class="activation-planet-filter-mark" d="${planetFilterMark(checked)}" opacity="${checked === false ? 0 : 1}" fill="none" stroke="#fffef9" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" pointer-events="none"/>
    </g>`;
}

// Measure the rendered Sun number, not its button or the separate fixing mark.
// Relative SVG coordinates cancel the camera's zoom and pan.
export function alignPersonalityHeading(root: Element) {
  const column = root.querySelector('.activation-column[data-source="personality"]');
  const heading = column?.querySelector<SVGGraphicsElement>('.activation-heading');
  const rule = column?.querySelector('.activation-header-rule');
  const value = column?.querySelector<SVGGraphicsElement>('[data-activation="personality-sun"] > text');
  if (heading?.textContent !== 'Личность' || !rule || !value) return;
  const columnMatrix = heading.getCTM(), valueMatrix = value.getCTM();
  if (!columnMatrix || !valueMatrix) return;
  const bounds = value.getBBox();
  if (!Number.isFinite(bounds.width) || bounds.width <= 0) return;
  const relative = columnMatrix.inverse().multiply(valueMatrix);
  const right = relative.a * (bounds.x + bounds.width) + relative.c * bounds.y + relative.e;
  const startX = activationHeadingX(column!.getAttribute('data-column-side') as ColumnSide);
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
export function describeActivationColumns(chart: ChartView, selectedGates: ReadonlySet<number> = new Set(), selection: SelectionTarget | null = null, { pressedGates = selectedGates, pressedSelection = selection, selections = [selection].filter((item): item is SelectionTarget => !!item), pressedSelections = [pressedSelection].filter((item): item is SelectionTarget => !!item), previewGates = new Set() }: ColumnSelectionOptions = {}) {
  chart = primaryChart(chart);
  if (chart.source === 'manual') return [];
  if (!chart.activations && !chart.planetFilter?.activations && !chart.planetFilter?.designActivations) return [];
  const fixings = lineFixingsFor(chart);
  const planetFilter = chart.planetFilter;
  const columns = ([['design', 'left'], ['personality', 'right']] as const).map(([source, columnSide]) => {
    const hasPlanetFilter = Boolean(planetFilter);
    const hasPlanetControl = hasPlanetFilter && planetFilter!.perPlanetControls === true;
    const hasMasterControl = hasPlanetFilter && (source === 'design' || hasPlanetControl);
    const selectedPlanets = new Set((source === 'design' ? planetFilter?.selectedDesignPlanets : planetFilter?.selectedPlanets) || []);
    const filterPrefix = source === 'design' ? 'design:' : '';
    const entries = hasPlanetFilter ? (source === 'design' ? planetFilter!.designActivations : planetFilter!.activations) : chart.activations?.[source];
    if (!Array.isArray(entries) || !entries.length) return null;
    const x = ACTIVATION_COLUMN_LAYOUT.x[columnSide];
    const label = source === 'design' ? 'Дизайн' : chart.source === 'transit' ? 'Транзит' : 'Личность';
    const color = source === 'design' ? '#c32d35' : '#202020';
    const rows = PLANETS.map(([planet, symbol, name], index) => {
      const entry = entries.find(item => item.planet === planet);
      if (!entry || !Number.isInteger(entry.gate) || entry.gate < 1 || entry.gate > 64 || !Number.isInteger(entry.line) || entry.line < 1 || entry.line > 6) return null;
      const planetEnabled = !hasPlanetFilter || selectedPlanets.has(planet);
      const selected = selectedGates.has(entry.gate) || previewGates.has(entry.gate);
      const pressed = pressedGates.has(entry.gate);
      const fixing = planetEnabled ? fixings.get(`${source}-${planet}`)?.state : undefined;
      const fixingLabel = FIXING_LABELS[fixing as keyof typeof FIXING_LABELS];
      const id = `${source}-${planet}`;
      const planetAria = `${label}, ${name}`;
      const planetTarget = describePlanetTarget({ id, symbol, label: planetAria,
        geometry: activationPlanetLayout(), selections, pressedSelections, enabled: planetEnabled });
      return { id, source, planet, symbol, name, x, y: activationRowY(index), label,
        gate: entry.gate, line: entry.line, selected, pressed, fixing, fixingLabel, planetTarget, hasPlanetControl, planetEnabled, filterId: `${filterPrefix}${planet}`,
        planetAria,
        gateAria: `${label}, ${name}: ворота ${entry.gate}, линия ${entry.line}${fixingLabel ? `, ${fixingLabel.toLowerCase()}` : ''}`,
      };
    }).filter((item): item is NonNullable<typeof item> => !!item);
    const enabledCount = PLANETS.filter(([planet]) => selectedPlanets.has(planet)).length;
    return { source, columnSide, x, label, color, rows, hasMasterControl, filterId: `${filterPrefix}all`,
      allPlanetsChecked: enabledCount === PLANETS.length ? true : enabledCount ? 'mixed' as const : false,
      transform: activationBlockTransform(columnSide), headingWidth: ACTIVATION_COLUMN_LAYOUT.headingWidths[label] };
  }).filter((item): item is NonNullable<typeof item> => !!item);
  return columns;
}

export function renderActivationRow(row: ActivationRow) {
  const { id, x, y, gate, line, selected, pressed, fixing, planetTarget, planetAria, gateAria, hasPlanetControl, filterId, planetEnabled = true } = row;
  const target = activationTargetLayout();
  return `<g class="activation-row" transform="translate(${x} ${y})">
        ${hasPlanetControl ? renderPlanetFilterControl(filterId, planetAria, planetEnabled) : ''}
        ${renderPlanetTarget(planetTarget)}
        <g class="bg-activation" data-type="gate" data-id="${gate}" data-activation="${id}" data-selected="${selected}" tabindex="0" role="button" aria-label="${gateAria}" aria-pressed="${pressed}"${planetEnabled ? '' : ' opacity=".22"'}>
          <rect x="${ACTIVATION_ROW_LAYOUT.valueX[0] + ACTIVATION_ROW_LAYOUT.rectX}" y="${target.hitY}" width="${ACTIVATION_ROW_LAYOUT.hitWidth}" height="${target.hitHeight}" rx="${target.hitRadius}" fill="${selected ? '#eaf0f8' : 'transparent'}"/>
          <text x="${ACTIVATION_COLUMN_LAYOUT.valueOffsetX}" y="0" dominant-baseline="central" font-size="${ACTIVATION_ROW_LAYOUT.fontSize}" font-weight="500" pointer-events="none">${gate}<tspan font-weight="400" opacity=".7">.${line}</tspan></text>
        </g>
        ${fixingMark(fixing)}
      </g>`;
}

export function renderActivationColumn(column: ActivationColumn) {
  const { source, columnSide, x, label, color, transform, headingWidth, rows, hasMasterControl, filterId, allPlanetsChecked } = column;
  return `<g class="activation-column" data-source="${source}" fill="${color}" data-column-side="${columnSide}" font-family="Inter, -apple-system, BlinkMacSystemFont, sans-serif" style="font-variant-numeric: tabular-nums">
      <g class="activation-block-content" transform="${transform}">
      <text class="activation-heading" x="${activationHeadingX(columnSide)}" y="${ACTIVATION_COLUMN_LAYOUT.headingY}" font-size="16" font-weight="500">${label}</text>
      <path class="activation-header-rule" d="M ${activationHeadingX(columnSide)} ${ACTIVATION_COLUMN_LAYOUT.ruleY} h ${headingWidth}" stroke="${color}" stroke-opacity=".18" stroke-width="1" fill="none"/>
      ${hasMasterControl ? renderPlanetFilterControl(filterId, `${label}, все планеты`, allPlanetsChecked, `translate(${x} ${ACTIVATION_COLUMN_LAYOUT.headingY - 6})`) : ''}
      ${rows.map(renderActivationRow).join('')}
      </g>
    </g>`;
}

export function renderActivationColumns(chart: ChartView, selectedGates: ReadonlySet<number> = new Set(), selection: SelectionTarget | null = null, options: ColumnSelectionOptions = {}) {
  if (isChartOverlay(chart)) {
    const { pressedSelection = selection, selections = [selection].filter((item): item is SelectionTarget => !!item), pressedSelections = [pressedSelection].filter((item): item is SelectionTarget => !!item) } = options;
    return renderOverlayActivationColumns(chart, selectedGates, options.pressedGates || selectedGates, { ...options, selections, pressedSelections });
  }
  const columns = describeActivationColumns(chart, selectedGates, selection, options);
  return columns.length ? `<g class="activation-columns">${columns.map(renderActivationColumn).join('')}</g>` : '';
}
