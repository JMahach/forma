import type { SelectionTarget } from '../selection/selection-targets.ts';
import type { activationPlanetLayout } from './geometry/activation-layout.ts';
import type { AttributeValue } from './svg-patches.ts';
interface PlanetTargetInput {
  id: string;
  symbol: string;
  label: string;
  color?: string;
  enabled?: boolean;
  available?: boolean;
  geometry: ReturnType<typeof activationPlanetLayout>;
  selections?: readonly SelectionTarget[];
  pressedSelections?: readonly SelectionTarget[];
}
export type PlanetTarget = ReturnType<typeof describePlanetTarget>;

import { PALETTE, ACTIVATION_HIGHLIGHT_OPACITY } from '../ui/chart-palette.ts';
import { ACTIVATION_COLUMN_LAYOUT, activationRowY } from './geometry/activation-layout.ts';
import { setAttributes } from './svg-patches.ts';
import { escapeHtml as esc } from '../ui/html.ts';

// One planet target for every activation column. The column supplies provenance
// and geometry; pointer/keyboard gestures and selection remain scene-wide.
export function describePlanetTarget({ selections = [], pressedSelections = [], available = true, ...target }: PlanetTargetInput) {
  return { ...target, available,
    selected: available && selections.some(value => value.type === 'planet' && value.id === target.id),
    pressed: available && pressedSelections.some(value => value.type === 'planet' && value.id === target.id) };
}
const targetAttributes = (model: PlanetTarget) => ({
  class: model.available ? 'bg-activation bg-planet' : 'bg-planet',
  'data-type': model.available ? 'planet' : null,
  'data-id': model.available ? model.id : null,
  'data-activation': model.available ? `${model.id}-planet` : null,
  tabindex: model.available ? 0 : null, role: model.available ? 'button' : null,
  'aria-label': model.available ? model.label : null,
  'aria-pressed': model.available ? model.pressed : null,
  'aria-hidden': model.available ? null : true,
  'pointer-events': model.available ? null : 'none',
  opacity: model.enabled === false ? '.35' : null,
});
const rectAttributes = (model: PlanetTarget) => ({ x: model.geometry.rectX, y: model.geometry.hitY,
  width: model.geometry.hitWidth, height: model.geometry.hitHeight, rx: model.geometry.hitRadius,
  fill: model.selected ? PALETTE.halo : 'transparent', 'fill-opacity': ACTIVATION_HIGHLIGHT_OPACITY });
const glyphAttributes = (model: PlanetTarget) => ({ class: 'planet-symbol', x: model.geometry.x, y: model.geometry.y,
  fill: model.color ?? null, 'text-anchor': 'middle', 'dominant-baseline': 'central',
  'font-size': model.geometry.fontSize, 'pointer-events': 'none' });
const attributes = (values: Record<string, AttributeValue>) => Object.entries(values).filter(([, value]) => value !== null && value !== undefined)
  .map(([name, value]) => ` ${name}="${esc(value)}"`).join('');

export function renderPlanetTarget(model: PlanetTarget) {
  return `<g${attributes(targetAttributes(model))}>
    <rect${attributes(rectAttributes(model))}/><text${attributes(glyphAttributes(model))}>${esc(model.symbol)}</text></g>`;
}
export function capturePlanetTarget(node: SVGElement) {
  return { node, rect: node.querySelector('rect')!, glyph: node.querySelector('text')! };
}
export function updatePlanetTarget(record: ReturnType<typeof capturePlanetTarget>, model: PlanetTarget) {
  setAttributes(record.node, targetAttributes(model));
  setAttributes(record.rect, rectAttributes(model));
  setAttributes(record.glyph, glyphAttributes(model));
  if (record.glyph.textContent !== model.symbol) record.glyph.textContent = model.symbol;
}

// Frame and header separator share exactly the same horizontal footprint.
export function activationPanelGeometry(x: number, right = 108, rowOffset = 0) {
  const y = ACTIVATION_COLUMN_LAYOUT.headingY - 22;
  return { x: x - 12, y, width: right + 12 + ACTIVATION_COLUMN_LAYOUT.panelRightPadding,
    height: activationRowY(12) + rowOffset + ACTIVATION_COLUMN_LAYOUT.rowStep / 2 + 4 - y };
}
export function activationPanelRule(x: number, right = 108) {
  const panel = activationPanelGeometry(x, right);
  return `M ${panel.x} ${ACTIVATION_COLUMN_LAYOUT.ruleY} h ${panel.width}`;
}

// The frame is visual only; map gestures still pass through unused panel space.
export function activationPanelAttributes(x: number, color: string, right = 108, rowOffset = 0) {
  return { class: 'activation-panel', ...activationPanelGeometry(x, right, rowOffset),
    rx: 14, fill: color, 'fill-opacity': .045, stroke: color, 'stroke-opacity': .55,
    'stroke-width': 1, 'pointer-events': 'none' };
}
export function renderActivationPanel(x: number, color: string, right = 108, rowOffset = 0) {
  return `<rect${attributes(activationPanelAttributes(x, color, right, rowOffset))}/>`;
}
