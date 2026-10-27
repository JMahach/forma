import test from 'node:test';
import assert from 'node:assert/strict';
import { renderBodygraph } from '../src/scene/bodygraph-svg.ts';
import { createBodygraphPainter } from '../src/scene/bodygraph-painter.ts';
import { createRenderState, type RenderOptions } from '../src/scene/render-state.ts';
import { CHANNELS } from '../src/scene/geometry/chart-geometry.ts';
import { INTEGRATION_PATH } from '../src/scene/geometry/drawing-geometry.ts';
import { SVG_NS, svgDocument, type SvgElement } from './helpers/svg-dom.ts';

const underpass = CHANNELS.find(channel => channel.id === '26-44')!;
const upperPaths = ['5-15', '2-14', '29-46'].map(id => CHANNELS.find(channel => channel.id === id)!.path);
const getMask = (root: SvgElement, node: SvgElement) => {
  const url = node.getAttribute('mask');
  assert.ok(url, 'crisp outline has a clipping mask');
  return root.querySelector(`mask[id="${url.slice(5, -1)}"]`)!;
};
const cuts = (mask: SvgElement, d: string) => mask.querySelectorAll('path').filter(path => path.getAttribute('d') === d);

function verifyCrossing(root: SvgElement) {
  for (const id of ['5-15', '2-14', '29-46']) {
    const channel = root.querySelector(`[data-type="channel"][data-id="${id}"]`)!;
    for (const node of [channel.querySelector('.bg-channel-highlight')!, ...channel.querySelectorAll('[data-highlight-gate]')]) {
      assert.equal(cuts(getMask(root, node), underpass.path).length, 0, `${id} stays continuous above 26–44`);
    }
  }
  const integration = root.querySelector('.bodygraph-integration-highlights')!;
  assert.equal(cuts(getMask(root, integration), underpass.path).length, 0, 'branch 34 stays continuous above 26–44');
  const lower = root.querySelector('[data-type="channel"][data-id="26-44"]')!;
  for (const node of [lower.querySelector('.bg-channel-highlight')!, ...lower.querySelectorAll('[data-highlight-gate]')]) {
    const mask = getMask(root, node);
    assert.equal(cuts(mask, underpass.path)[0]?.getAttribute('stroke-width'), '12.06', 'own gap stays compact');
    for (const path of [...upperPaths, INTEGRATION_PATH]) {
      assert.equal(cuts(mask, path)[0]?.getAttribute('stroke-width'), '10.56',
        'lower outline reaches the physical upper channel edge without any crossing gap');
    }
  }
  const center = root.querySelector('[data-type="center"][data-id="heart"] .bg-center-highlight')!;
  assert.equal(cuts(getMask(root, center), underpass.path).length, 1, 'center junction still cuts the channel opening');
}

test('crossing hierarchy survives full, half, center and hover selection without underpass gaps', () => {
  const chart = { personality: [26, 29, 34], design: [44, 46, 20] };
  const root = svgDocument().createElementNS(SVG_NS, 'svg');
  const initial: RenderOptions = { idPrefix: 'crossing' };
  root.innerHTML = renderBodygraph(chart, null, initial);
  const painter = createBodygraphPainter(root as unknown as Element, createRenderState(chart, null, initial), initial);
  const scenarios: RenderOptions[] = [
    { selections: [{ type: 'channel', id: '26-44' }, { type: 'channel', id: '29-46' }] },
    { selections: [{ type: 'gate', id: 26 }, { type: 'gate', id: 29 }] },
    { selections: [{ type: 'center', id: 'sacral' }], previewSelection: { type: 'center', id: 'heart' } },
    { selections: [{ type: 'gate', id: 44 }], previewSelection: { type: 'integration', id: 'integration' } },
  ];
  for (const scenario of scenarios) {
    const options = { ...initial, ...scenario };
    painter.update(createRenderState(chart, null, options), options);
    verifyCrossing(root);
    const fresh = svgDocument().createElementNS(SVG_NS, 'svg');
    fresh.innerHTML = renderBodygraph(chart, null, options);
    verifyCrossing(fresh);
  }
  painter.dispose();
});
