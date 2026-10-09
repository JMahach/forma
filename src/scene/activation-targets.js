import { setAttributes } from './svg-patches.js';
import { escapeHtml as esc } from '../ui/html.js';

// One planet target for every activation column. The column supplies provenance
// and geometry; pointer/keyboard gestures and selection remain scene-wide.
export function describePlanetTarget({ selections = [], pressedSelections = [], available = true, ...target }) {
  return { ...target, available,
    selected: available && selections.some(value => value.type === 'planet' && value.id === target.id),
    pressed: available && pressedSelections.some(value => value.type === 'planet' && value.id === target.id) };
}
const targetAttributes = model => ({
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
const rectAttributes = model => ({ x: model.geometry.rectX, y: model.geometry.hitY,
  width: model.geometry.hitWidth, height: model.geometry.hitHeight, rx: model.geometry.hitRadius,
  fill: model.selected ? '#eaf0f8' : 'transparent' });
const glyphAttributes = model => ({ class: 'planet-symbol', x: model.geometry.x, y: model.geometry.y,
  fill: model.color ?? null, 'text-anchor': 'middle', 'dominant-baseline': 'central',
  'font-size': model.geometry.fontSize, 'pointer-events': 'none' });
const attributes = values => Object.entries(values).filter(([, value]) => value !== null && value !== undefined)
  .map(([name, value]) => ` ${name}="${esc(value)}"`).join('');

export function renderPlanetTarget(model) {
  return `<g${attributes(targetAttributes(model))}>${model.title ? `<title>${esc(model.title)}</title>` : ''}
    <rect${attributes(rectAttributes(model))}/><text${attributes(glyphAttributes(model))}>${esc(model.symbol)}</text></g>`;
}
export function capturePlanetTarget(node) {
  return { node, rect: node.querySelector('rect'), glyph: node.querySelector('text'), title: node.querySelector('title') };
}
export function updatePlanetTarget(record, model) {
  setAttributes(record.node, targetAttributes(model));
  setAttributes(record.rect, rectAttributes(model));
  setAttributes(record.glyph, glyphAttributes(model));
  if (record.glyph.textContent !== model.symbol) record.glyph.textContent = model.symbol;
  if (record.title && record.title.textContent !== model.title) record.title.textContent = model.title;
}
