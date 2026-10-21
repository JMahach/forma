import type { RenderOptions } from '../src/scene/render-state.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { renderBodygraph } from '../src/scene/bodygraph-svg.ts';
import { createSceneRenderer } from '../src/scene/renderer.ts';
import { svgDocument, SVG_NS } from './helpers/svg-dom.ts';
import type { BinaryLike } from 'crypto';

const hash = (value: BinaryLike) => createHash('sha256').update(value).digest('hex');
const chart = { personality: [20, 34, 7, 31], design: [20, 34, 37, 40] };

test('showGates remains an unknown option in the published drawing contract and cannot remove 64 gates', () => {
  for (const options of [{}, { interactive: false }, { showMandala: true }, { showBackdrop: true }] as const) {
    for (const selection of [null, { type: 'gate' as const, id: 20 }, { type: 'center' as const, id: 'root' }] as const) {
      const expected = renderBodygraph(chart, selection, options);
      const actual = renderBodygraph(chart, selection, { ...options, showGates: false } as RenderOptions & { showGates?: boolean });
      assert.equal(hash(actual), hash(expected));
      assert.equal([...actual.slice(actual.indexOf('class="bodygraph-gates"')).matchAll(/data-type="gate" data-id="\d+"/g)].length, 64);
    }
  }
});

test('only the explicit thumbnail profile omits gate artwork; accidental display options cannot expose it', () => {
  for (const showGates of [undefined, false, true] as const) {
    const actual = renderBodygraph(chart, { type: 'gate' as const, id: 20 }, { profile: 'thumbnail', showGates, interactive: true } as RenderOptions & { showGates?: boolean });
    assert.doesNotMatch(actual, /class="bodygraph-gates"|data-type="gate"/);
    assert.match(actual, /class="bodygraph-centers"/);
  }
});

test('changing the unsupported showGates option does not remount the persistent scene or its targets', () => {
  const document = svgDocument(), root = document.createElementNS(SVG_NS, 'svg');
  const renderer = createSceneRenderer(root);
  renderer.update(chart);
  const gates = root.querySelector('.bodygraph-gates');
  const targets = [...gates!.children], writes = root.innerHTMLWrites;
  renderer.update(chart, null, { showGates: false } as RenderOptions & { showGates?: boolean });
  assert.equal(root.innerHTMLWrites, writes);
  assert.equal(root.querySelector('.bodygraph-gates'), gates);
  assert.deepEqual(gates!.children, targets);
  assert.equal(targets.length, 64);
});
