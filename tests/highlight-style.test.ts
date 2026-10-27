import test from 'node:test';
import assert from 'node:assert/strict';
import { renderBodygraph } from '../src/scene/bodygraph-svg.ts';
import { createSceneRenderer } from '../src/scene/renderer.ts';
import { createChartHighlight } from '../src/state/chart-highlight.ts';
import { svgDocument, SVG_NS } from './helpers/svg-dom.ts';

const chart = { personality: [20, 34, 7, 31], design: [20, 34, 37, 40] };
const choices = [null, { type: 'center', id: 'throat' }, { type: 'gate', id: 20 },
  { type: 'channel', id: '20-34' }, { type: 'integration', id: 'integration' }] as const;

test('both highlight styles retain physical paint, pressed selection and camera transform through repeated switches', () => {
  const document = svgDocument(), root = document.createElementNS(SVG_NS, 'g');
  root.setAttribute('transform', 'translate(35 17) scale(2)');
  const renderer = createSceneRenderer(root);
  for (const highlightStyle of ['outline', 'glow', 'outline', 'glow'] as const) {
    for (const selection of choices) {
      const options = { highlightStyle, selections: selection ? [selection] : [] };
      renderer.update(chart, selection, options);
      const fresh = document.createElementNS(SVG_NS, 'g');
      fresh.innerHTML = renderBodygraph(chart, selection, options);
      for (const selector of ['.bg-center-highlight', '.bg-gate-glow', '.bg-gate-highlight',
        '.bg-integration-selection', '[data-highlight-gate]', 'mask', '.bodygraph-integration-paint']) {
        assert.deepEqual(root.querySelectorAll(selector).map(n => n.outerHTML), fresh.querySelectorAll(selector).map(n => n.outerHTML), `${highlightStyle}: ${selector}`);
      }
      assert.equal(root.getAttribute('transform'), 'translate(35 17) scale(2)');
      assert.equal(root.querySelector('.bg-channel-outline')?.getAttribute('stroke-width'), '10.56');
      assert.equal(root.querySelector('.bg-gate-disc')?.getAttribute('r'), '8.4');
      assert.equal(root.querySelectorAll('[aria-pressed="true"]').length, selection ? 1 : 0);
      assert.equal(root.querySelectorAll('filter').length, highlightStyle === 'glow' ? 2 : 0);
    }
  }
});

test('highlight preference changes once, ignores invalid values and supports unsubscribe', () => {
  const style = createChartHighlight(), values: string[] = [];
  assert.equal(style.current, 'glow');
  const unsubscribe = style.subscribe(value => values.push(value));
  style.set('outline'); style.set('outline'); style.set('invalid'); style.set('glow');
  assert.deepEqual(values, ['outline', 'glow']);
  unsubscribe(); style.set('outline');
  assert.deepEqual(values, ['outline', 'glow']);
});


test('pinned center darkens its whole blue family while simultaneous hover retains the original blue', () => {
  const document = svgDocument(), root = document.createElementNS(SVG_NS, 'svg');
  const renderer = createSceneRenderer(root);
  for (const highlightStyle of ['glow', 'outline'] as const) {
    const selected = { type: 'center', id: 'throat' } as const;
    const previewSelection = { type: 'center', id: 'g' } as const;
    renderer.update(chart, null, { highlightStyle, previewSelection: selected });
    const center = root.querySelector('[data-type="center"][data-id="throat"] .bg-center-shape')!;
    const original = center.getAttribute('fill');
    renderer.update(chart, selected, { highlightStyle, previewSelection });
    assert.equal(center.getAttribute('fill'), original, 'physical center color is untouched');
    assert.equal(root.querySelectorAll('.bg-center-selection').length, 0, 'no extra inner border or dark veil');
    assert.equal(root.querySelector('[data-type="center"][data-id="throat"] .bg-center-highlight')?.getAttribute('stroke'), '#83a9d2');
    assert.equal(root.querySelector('[data-type="gate"][data-id="8"] .bg-gate-glow')?.getAttribute('stroke'), '#83a9d2');
    assert.equal(root.querySelector('[data-highlight-gate="8"] path')?.getAttribute('stroke'), '#83a9d2');
    assert.equal(root.querySelector('[data-type="center"][data-id="g"] .bg-center-highlight')?.getAttribute('stroke'), '#91bce9');
    assert.equal(root.querySelector('[data-type="gate"][data-id="2"] .bg-gate-glow')?.getAttribute('stroke'), '#91bce9');
    const pattern = root.querySelector('pattern')!;
    assert.equal(pattern.querySelector('rect')?.getAttribute('fill'), '#91bce9');
    assert.equal(pattern.querySelector('path')?.getAttribute('stroke'), '#83a9d2');
    const owners = root.querySelectorAll('.bg-integration-color-defs [data-owner-gate]').map(n => n.getAttribute('data-owner-gate'));
    assert.deepEqual(owners, ['20'], 'hovered G-center arm 10 cannot enter the committed color mask');
    renderer.update(chart, null, { highlightStyle, previewSelection: selected });
    assert.equal(root.querySelector('[data-highlight-gate="8"] path')?.getAttribute('stroke'), '#91bce9', 'unpin restores the same retained half to hover blue');
    assert.equal(root.querySelectorAll('pattern').length, 0);
  }
});
