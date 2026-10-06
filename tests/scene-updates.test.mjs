import test from 'node:test';
import assert from 'node:assert/strict';
import { createGraphController } from '../src/scene/updates.js';
import { SVG_NS, svgDocument } from './helpers/svg-dom.mjs';

const chart = { id: 'first', personality: [], design: [] };

test('graph controller uses the supplied scene and refreshes the popover only when its chart changes', () => {
  const viewport = svgDocument().createElementNS(SVG_NS, 'svg');
  const calls = [], refreshed = [];
  let current = chart, available = true, closes = 0;
  const graph = createGraphController({ viewport, getChart: () => current, hasChart: () => available,
    scene: { update(...args) { calls.push(args); }, clear() { calls.push('clear'); } },
    activationPopover: { refresh(value) { refreshed.push(value); }, close() { closes++; } },
  });
  graph.render();
  graph.render();
  current = { ...chart, id: 'second' };
  graph.render();
  assert.equal(calls.length, 3);
  assert.equal(calls[0][0], chart);
  assert.equal(calls[2][0], current);
  assert.equal(calls[0][2].profile, 'studio');
  assert.equal(viewport.innerHTMLWrites, 0, 'the controller never replaces scene markup itself');
  assert.deepEqual(refreshed, [chart, current]);
  available = false;
  graph.render();
  assert.equal(calls.at(-1), 'clear');
  assert.equal(closes, 1);
});

test('graph controller restores activation, bodygraph and mandala focus after a scene replacement', () => {
  for (const [dataset, mandala, selector] of [
    [{ type: 'gate', id: '12', activation: 'personality-sun' }, false, '[data-activation="personality-sun"]'],
    [{ type: 'gate', id: '12' }, false, '.bodygraph-drawing .bg-interactive[data-type="gate"][data-id="12"]'],
    [{ type: 'gate', id: '12' }, true, '.mandala-gate[data-type="gate"][data-id="12"]'],
  ]) {
    const viewport = svgDocument().createElementNS(SVG_NS, 'svg');
    const focused = { dataset, classList: { contains: () => mandala }, closest: () => focused };
    let active = focused, restored = 0;
    const replacement = { focus(options) { assert.deepEqual(options, { preventScroll: true }); active = replacement; restored++; } };
    const query = viewport.querySelector.bind(viewport);
    viewport.querySelector = value => value === selector ? replacement : query(value);
    const graph = createGraphController({ viewport, getChart: () => chart, getActiveElement: () => active,
      scene: { update() { active = null; }, clear() {} },
      activationPopover: { refresh() {}, close() {} },
    });
    graph.render();
    assert.equal(restored, 1);
    assert.equal(active, replacement);
  }
});
