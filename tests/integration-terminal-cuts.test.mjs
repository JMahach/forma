import test from 'node:test';
import assert from 'node:assert/strict';
import { renderBodygraph } from '../src/scene/bodygraph-svg.js';
import { getGate } from '../src/scene/geometry/chart-geometry.js';
import { INTEGRATION_ARMS } from '../src/scene/geometry/integration-geometry.js';

const gate = id => ({ type: 'gate', id });
const center = id => ({ type: 'center', id: getGate(id).center });
const render = (chart, selections, previewSelection) => renderBodygraph(chart, null, { selections, previewSelection });
const selectionMask = markup => markup.match(/<mask id="bodygraph-integration-selection-outline"[^>]*>([\s\S]*?)<\/mask>/)?.[1];
const focusMask = (markup, id) => markup.match(new RegExp(`<mask id="bodygraph-integration-focus-${id}"[^>]*>([\\s\\S]*?)<\\/mask>`))?.[1];
const owned = mask => mask.match(/<g clip-path="[^"]+">[\s\S]*?<\/g>|<path class="bg-integration-owned-[^"]+"[^>]*\/>/g) || [];
const physical = mask => mask.match(/<path class="bg-integration-interior"[^>]*\/>/)?.[0];

for (const [outer, inner, id] of [[20, 10, '10-20'], [57, 34, '34-57']]) {
  test(`${id}: a second gate or center cannot restore a round cap past the physical terminal cut`, () => {
    for (const chart of [{}, { personality: [outer] }, { design: [inner] }, { personality: [10,20,34,57], design: [10,20,34,57] }]) {
      const singleMasks = [outer, inner].map(id => selectionMask(render(chart, [gate(id)])));
      const expectedOwned = singleMasks.flatMap(owned).sort();
      const pairMask = selectionMask(render(chart, [gate(outer), gate(inner)]));
      assert.ok(pairMask);
      assert.doesNotMatch(pairMask, /bg-integration-connected-/, 'a same-fork pair retains the existing cut instead of adding an unbounded round footprint');
      assert.deepEqual(owned(pairMask).sort(), expectedOwned, 'the two approved single-arm boundaries remain the complete pair footprint');
      assert.equal(physical(pairMask), physical(singleMasks[0]));
      assert.ok(pairMask.endsWith(physical(pairMask)), 'the actual channel interior is the final cutout');
      for (const selections of [[gate(outer), center(inner)], [center(outer), gate(inner)], [center(inner), center(outer)], [gate(inner), gate(outer)]]) {
        assert.equal(selectionMask(render(chart, selections)), pairMask, 'gate and center selection have exactly the same integration boundary');
      }
      for (const preview of [gate(inner), center(inner)]) {
        assert.equal(selectionMask(render(chart, [gate(outer)], preview)), pairMask, 'hover uses the exact pinned cut, not another cap');
      }
      assert.equal(focusMask(render(chart, []), id), pairMask, 'keyboard focus cannot restore the cap either');
    }
  });

  test(`${id}: the former exterior cap lies beyond the existing physical end plane`, () => {
    const arm = INTEGRATION_ARMS.find(arm => arm.gate === outer);
    const sample = t => [0, 1].map(axis => {
      const u = 1 - t;
      return Number((u ** 3 * arm.curve[0][axis] + 3 * u * u * t * arm.curve[1][axis]
        + 3 * u * t * t * arm.curve[2][axis] + t ** 3 * arm.curve[3][axis]).toFixed(2));
    });
    const end = sample(1), before = sample(47 / 48);
    const delta = end.map((v, i) => v - before[i]), length = Math.hypot(...delta);
    const tangent = delta.map(v => v / length), normal = [-tangent[1], tangent[0]];
    const side = outer === 20 ? 1 : -1;
    const witness = end.map((v, i) => v + 2 * tangent[i] + side * 5.016 * normal[i]);
    const along = witness.reduce((sum, v, i) => sum + (v - end[i]) * tangent[i], 0);
    assert.ok(along > 1.99, 'the rounded-cap witness is past the straight terminal, not on the retained side');
    assert.ok(Math.hypot(...witness.map((v, i) => v - end[i])) < 6.6, 'an unclipped round 13.2px footprint could cover this witness');
    const mask = selectionMask(render({}, [gate(outer), gate(inner)]));
    assert.match(mask, new RegExp(`clip-path="url\\(#bodygraph-integration-end-${outer}\\)"`));
    assert.match(mask, /clip-path="url\(#bodygraph-integration-inner-side\)"/);
    assert.doesNotMatch(mask, /bg-integration-connected-footprint/, 'no later white footprint can repaint the forbidden exterior cap');
  });
}

test('cross-node connections keep their continuous stem ring', () => {
  for (const pair of [[20,34], [20,57], [10,34], [10,57]]) {
    const mask = selectionMask(render({}, pair.map(gate)));
    assert.match(mask, /bg-integration-connected-footprint/);
    assert.match(mask, /bg-integration-owned-stem/);
  }
});
