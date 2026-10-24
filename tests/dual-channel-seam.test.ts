import test from 'node:test';
import assert from 'node:assert/strict';
import { paintGateActivation } from '../src/scene/bodygraph-paint.ts';
import { createRenderState } from '../src/scene/render-state.ts';

test('dual channel paint fills the central gap with black while preserving red and both outside edges', () => {
  const state = createRenderState({ personality: [31], design: [31] }, null, {});
  const markup = paintGateActivation([[0, 0], [0, 100]], state, 31);
  const paths = [...markup.matchAll(/<path\b[^>]*\/>/g)].map(([tag]) => {
    const attr = (name: string) => tag.match(new RegExp(`\\b${name}="([^"]*)"`))![1];
    return { x: Number(attr('d').match(/^M(-?[\d.]+),/)![1]), width: Number(attr('stroke-width')), color: attr('stroke') };
  });
  assert.equal(paths.length, 2, 'the two native source lanes close the gap without a filler path');
  for (const [x, expected] of [[-3.2, null], [-3.09, '#c32d35'], [-1, '#c32d35'], [-.05, '#202020'],
    [0, '#202020'], [.05, '#202020'], [1, '#202020'], [3.09, '#202020'], [3.2, null]] as const) {
    const visible = paths.filter(path => Math.abs(x - path.x) <= path.width / 2).at(-1)?.color ?? null;
    assert.equal(visible, expected, `cross-section at x=${x} keeps the intended color`);
  }
});
