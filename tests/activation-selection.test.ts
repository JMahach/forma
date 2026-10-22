import type { SelectionTarget } from '../src/selection/selection-targets.ts';
import type { ChartView } from '../src/domain/chart-composition.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderActivationColumns, renderPlanetFilterControl } from '../src/scene/activation-columns.ts';
import { renderBodygraph } from '../src/scene/bodygraph-svg.ts';

const chart = {
  personality: [8, 29, 1], design: [8, 29],
  activations: {
    design: [
      { planet: 'sun', gate: 8, line: 2 },
      { planet: 'earth', gate: 8, line: 4 },
      { planet: 'moon', gate: 8, line: 2 },
      { planet: 'mercury', gate: 29, line: 2 },
      { planet: 'venus', gate: 29, line: 5 },
    ],
    personality: [
      { planet: 'sun', gate: 8, line: 2 },
      { planet: 'earth', gate: 8, line: 4 },
      { planet: 'moon', gate: 29, line: 2 },
      { planet: 'mercury', gate: 29, line: 6 },
      { planet: 'venus', gate: 1, line: 2 },
    ],
  },
} as unknown as ChartView;
const gate = (id: number) => ({ type: 'gate' as const, id });
const gate8Copies = ['design-sun', 'design-earth', 'design-moon', 'personality-sun', 'personality-earth'];
const gate29Copies = ['design-mercury', 'design-venus', 'personality-moon', 'personality-mercury'];
const attribute = (tag: string, name: string) => tag.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1];

function numericRows(markup: string) {
  return [...markup.matchAll(/<g\b[^>]*data-type="gate"[^>]*data-activation="[^"]+"[^>]*>[\s\S]*?<\/g>/g)]
    .map(([content]) => ({
      id: attribute(content, 'data-activation'),
      selected: attribute(content, 'data-selected') === 'true',
      pressed: attribute(content, 'aria-pressed') === 'true',
      painted: /<rect[^>]*fill="#eaf0f8"/.test(content),
    }));
}

function assertRows(markup: string, selected: Iterable<unknown>|null|undefined, pressed = selected) {
  const rows = numericRows(markup);
  assert.equal(rows.length, 10, 'every saved activation stays visible');
  assert.deepEqual(new Set(rows.filter(row => row.selected).map(row => row.id)), new Set(selected));
  assert.deepEqual(new Set(rows.filter(row => row.pressed).map(row => row.id)), new Set(pressed));
  for (const row of rows) assert.equal(row.painted, row.selected, `${row.id} paint follows its row highlight`);
}

const render = (selections: SelectionTarget[], options = {}) => renderBodygraph(chart, null, { selections, showActivations: true, ...options });

test('ordinary gate selection highlights every numeric copy across both columns', () => {
  const baseline = render([gate(8)]);
  assertRows(baseline, gate8Copies);
  assertRows(render([gate(8)], { previewSelection: gate(29) }), [...gate8Copies, ...gate29Copies], gate8Copies);
  assert.equal(render([gate(8)]), baseline, 'ending hover restores the exact committed selection');
});

test('channel and center hover add numeric copies without changing committed rows', () => {
  for (const previewSelection of [{ type: 'channel' as const, id: '1-8' }, { type: 'center' as const, id: 'throat' }] as const) {
    const previewRows = numericRows(render([], { previewSelection })).filter(row => row.selected).map(row => row.id);
    assertRows(render([gate(29)], { previewSelection }), [...gate29Copies, ...previewRows], gate29Copies);
  }
});

test('direct activation rendering keeps committed and preview inputs immutable', () => {
  const selectedGates = new Set([8]), previewGates = new Set([29]);
  const before = JSON.stringify(chart);
  assertRows(renderActivationColumns(chart, selectedGates, null, { previewGates }), [...gate8Copies, ...gate29Copies], gate8Copies);
  assert.deepEqual([...selectedGates], [8]);
  assert.deepEqual([...previewGates], [29]);
  assert.equal(JSON.stringify(chart), before);
});

test('planet controls keep accessible names without rejected hover captions', () => {
  const markup = render([]);
  const planets = [...markup.matchAll(/<g[^>]*data-type="planet"[^>]*>[\s\S]*?<\/g>/g)];
  assert.ok(planets.length > 0);
  for (const [planet] of planets) {
    assert.match(planet, /aria-label="[^"]+"/);
    assert.doesNotMatch(planet, /<title>/);
  }
  const group = renderPlanetFilterControl('design:all', 'Дизайн, все планеты', false);
  assert.match(group, /aria-label="Дизайн, все планеты"/);
  assert.match(group, /role="checkbox"/);
  assert.doesNotMatch(group, /<title>/);
});
