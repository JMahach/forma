import { PALETTE } from '../src/ui/chart-palette.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { INTEGRATION_CASES, INTEGRATION_GATES } from '../src/dev/integration-cases.ts';
import { integrationLayers, paintIntegrationLayers } from '../src/dev/integration-paint.ts';
import { createRenderState } from '../src/scene/render-state.ts';
import { INTEGRATION_ARMS } from '../src/scene/geometry/drawing-geometry.ts';

test('integration lab has thirty distinct states with every gate in every state', () => {
  assert.equal(INTEGRATION_CASES.length, 30);
  assert.equal(new Set(INTEGRATION_CASES.map(c => c.pattern)).size, 30);
  for (let i = 0; i < 4; i++) assert.deepEqual([...new Set(INTEGRATION_CASES.map(c => c.pattern[i]))].sort(), ['0','1','2','3']);
  for (let i = 0; i < 4; i++) for (let j = i + 1; j < 4; j++)
    assert.ok(INTEGRATION_CASES.some(c => [...c.pattern].every((s, k) => (k === i || k === j) ? s !== '0' : s === '0')), `pair ${i}/${j}`);
});
test('all 256 activation combinations paint red below black below dual and retain connected fork points', () => {
  for (let n = 0; n < 256; n++) {
    const states = INTEGRATION_GATES.map((_, i) => (n >> (i * 2)) & 3);
    const chart = { personality: INTEGRATION_GATES.filter((_, i) => states[i] & 2), design: INTEGRATION_GATES.filter((_, i) => states[i] & 1) };
    const layers = integrationLayers(createRenderState(chart, null, {}));
    assert.deepEqual(layers.map(l => l.rank), layers.map(l => l.rank).sort((a,b) => a-b));
    const crossing = states.slice(0,2).some(Boolean) && states.slice(2).some(Boolean);
    for (const layer of layers) {
      assert.ok(chart.personality.includes(layer.gate as typeof INTEGRATION_GATES[number]) || chart.design.includes(layer.gate as typeof INTEGRATION_GATES[number]));
      if (crossing) {
        const end = INTEGRATION_ARMS.find(a => a.gate === layer.gate)!.end;
        const position = layer.points.findIndex(p => Math.hypot(p[0]-end[0],p[1]-end[1]) < 1e-7);
        assert.ok(position > 0 && position < layer.points.length - 1, 'fork is inside a continuous path, not its cut end');
      }
    }
  }
});


test('case 22 paints all dual red lanes below every dual black lane', () => {
  const state = createRenderState(INTEGRATION_CASES[21], null, {});
  const markup = paintIntegrationLayers(state);
  const colors = [...markup.matchAll(/<path[^>]* stroke="([^"]+)"/g)].map(m => m[1]);
  assert.deepEqual(colors, [PALETTE.design, PALETTE.design, PALETTE.design, PALETTE.design,
    PALETTE.ink, PALETTE.ink, PALETTE.ink, PALETTE.ink]);
});
