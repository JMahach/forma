import test from 'node:test';
import assert from 'node:assert/strict';
import { renderBodygraph } from '../src/scene/bodygraph-svg.ts';
import { createSceneRenderer } from '../src/scene/renderer.ts';
import { createChartHighlight } from '../src/state/chart-highlight.ts';
import { svgDocument, SVG_NS, significantDOM } from './helpers/svg-dom.ts';

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
        assert.deepEqual(root.querySelectorAll(selector).map(n => significantDOM(n)), fresh.querySelectorAll(selector).map(n => significantDOM(n)), `${highlightStyle}: ${selector}`);
      }
      assert.equal(root.getAttribute('transform'), 'translate(35 17) scale(2)');
      assert.equal(root.querySelector('.bg-channel-outline')?.getAttribute('stroke-width'), '10.56');
      assert.equal(root.querySelector('.bg-gate-disc')?.getAttribute('r'), '8.4');
      assert.equal(root.querySelectorAll('[aria-pressed="true"]').length, selection ? 1 : 0);
      if (highlightStyle === 'outline') assert.equal(root.querySelectorAll('filter').length, 0);
      else for (const node of root.querySelectorAll('[filter]')) {
        const id = node.getAttribute('filter')!.match(/^url\(#(.+)\)$/)![1];
        const filter = root.querySelector(`#${id}`)!;
        assert.ok(filter, 'every visible effect has a filter');
        const source = filter.getAttribute('href');
        if (source) assert.ok(root.querySelector(source)?.querySelector('feGaussianBlur'), 'local regions inherit the common effect');
      }
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
    const pattern = root.querySelector('.bg-integration-color-defs pattern')!;
    assert.equal(pattern.querySelector('rect')?.getAttribute('fill'), '#91bce9');
    assert.equal(pattern.querySelector('path')?.getAttribute('stroke'), '#83a9d2');
    const owners = root.querySelectorAll('.bg-integration-color-defs [data-owner-gate]').map(n => n.getAttribute('data-owner-gate'));
    assert.deepEqual(owners, ['20'], 'hovered G-center arm 10 cannot enter the committed color mask');
    renderer.update(chart, null, { highlightStyle, previewSelection: selected });
    assert.equal(root.querySelector('[data-highlight-gate="8"] path')?.getAttribute('stroke'), '#91bce9', 'unpin restores the same retained half to hover blue');
    assert.equal(root.querySelectorAll('pattern').length, 0);
  }
});

test('hovering an ordinary full channel preserves the pinned gate or center color on its owned half', () => {
  for (const highlightStyle of ['glow', 'outline'] as const) {
    for (const pinned of [{ type: 'gate', id: 1 }, { type: 'center', id: 'g' }] as const) {
      const document = svgDocument(), root = document.createElementNS(SVG_NS, 'svg');
      const renderer = createSceneRenderer(root);
      const previewSelection = { type: 'channel', id: '1-8' } as const;
      for (const firstMountHovered of [true, false]) {
        renderer.clear();
        if (!firstMountHovered) renderer.update(chart, pinned, { highlightStyle, selections: [pinned] });
        renderer.update(chart, pinned, { highlightStyle, selections: [pinned], previewSelection });
        const halo = root.querySelector('[data-type="channel"][data-id="1-8"] .bg-channel-highlight')!;
        const colorId = halo.getAttribute('stroke')?.match(/^url\(#(.+)\)$/)?.[1];
        assert.ok(colorId, 'mixed ownership needs the pinned half and the hovered half to keep separate colors');
        const colors = root.querySelector(`#${colorId}`)!;
        assert.equal(colors.querySelector('rect')?.getAttribute('fill'), '#91bce9');
        assert.equal(colors.querySelector('[data-color-gate="1"]')?.getAttribute('stroke'), '#83a9d2');
        assert.equal(colors.querySelector('[data-color-gate="8"]'), null, 'the unpinned half keeps hover blue');
        renderer.update(chart, pinned, { highlightStyle, selections: [pinned] });
        assert.equal(root.querySelector('[data-type="channel"][data-id="1-8"] [data-highlight-gate="1"] path')?.getAttribute('stroke'), '#83a9d2');
        assert.equal(halo.getAttribute('opacity'), '0');
      }
      const channel = { type: 'channel', id: '1-8' } as const;
      renderer.update(chart, channel, { highlightStyle, selections: [pinned, channel], previewSelection });
      assert.equal(root.querySelector('[data-type="channel"][data-id="1-8"] .bg-channel-highlight')?.getAttribute('stroke'), '#83a9d2', 'a pinned whole channel owns the entire color');
    }
  }
});

test('small glow contours do not ask the browser to filter an entire chart', () => {
  const document = svgDocument(), root = document.createElementNS(SVG_NS, 'svg');
  root.innerHTML = renderBodygraph(chart, null, { highlightStyle: 'glow' });
  for (const [selector, maxWidth, maxHeight] of [
    ['[data-type="center"][data-id="throat"] .bg-center-highlight', 200, 200],
    ['[data-type="channel"][data-id="1-8"] .bg-channel-highlight', 70, 400],
  ] as const) {
    const target = root.querySelector(selector)!;
    const id = target.getAttribute('filter')!.match(/^url\(#(.+)\)$/)![1];
    const filter = root.querySelector(`#${id}`)!;
    const width = Number(filter.getAttribute('width')), height = Number(filter.getAttribute('height'));
    assert.ok(width > 0 && width < maxWidth, `${selector}: local positive width, got ${width}`);
    assert.ok(height > 0 && height < maxHeight, `${selector}: local positive height, got ${height}`);
  }
});

test('changing only highlight does not recompute physical integration distances', () => {
  const document = svgDocument(), root = document.createElementNS(SVG_NS, 'svg');
  const renderer = createSceneRenderer(root);
  const options = { highlightStyle: 'glow' as const, showActivations: false };
  renderer.update(chart, null, options);
  const physical = root.querySelector('.bodygraph-integration-paint')!;
  const children = [...physical.children];
  const original = Math.hypot;
  let distances = 0;
  try {
    Math.hypot = (...values: number[]) => { distances++; return original(...values); };
    renderer.update(chart, { type: 'center', id: 'head' }, options);
  } finally { Math.hypot = original; }
  assert.equal(distances, 0, 'unchanged physical geometry is already prepared');
  assert.deepEqual(physical.children, children);
});


test('native full-channel focus is already prepared to preserve a pinned half without a pointer update', () => {
  const document = svgDocument(), root = document.createElementNS(SVG_NS, 'svg');
  root.innerHTML = renderBodygraph(chart, { type: 'gate', id: 1 }, { highlightStyle: 'glow' });
  const halo = root.querySelector('[data-type="channel"][data-id="1-8"] .bg-channel-highlight')!;
  assert.equal(halo.getAttribute('opacity'), '0');
  const colorId = halo.getAttribute('stroke')?.match(/^url\(#(.+)\)$/)?.[1];
  assert.ok(colorId, 'CSS can reveal the whole halo without changing selected data');
  assert.equal(root.querySelector(`#${colorId} [data-color-gate="1"]`)?.getAttribute('stroke'), '#83a9d2');
});

test('first center selection starts without synchronous style reads or competing animations on persistent halos', () => {
  const document = svgDocument(), root = document.createElementNS(SVG_NS, 'svg');
  const renderer = createSceneRenderer(root);
  renderer.update(chart, null, { highlightStyle: 'glow' });
  Object.assign(document, { defaultView: {
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    getComputedStyle() { throw new Error('first selection must not synchronously measure changed paint'); },
  } });
  const create = document.createElementNS.bind(document);
  document.createElementNS = (ns, tag) => {
    const node = create(ns, tag);
    node.animate = () => ({ cancel() {}, onfinish: null }) as unknown as Animation;
    return node;
  };
  root.animate = () => ({ cancel() {} }) as Animation;
  for (const halo of root.querySelectorAll('.bg-center-highlight, .bg-gate-highlight, .bg-gate-glow, .bg-channel-highlight')) {
    halo.animate = () => { throw new Error('persistent contours use native CSS transitions only'); };
  }
  renderer.update(chart, { type: 'center', id: 'head' }, { highlightStyle: 'glow' });
  assert.equal(root.querySelector('[data-type="center"][data-id="head"] .bg-center-highlight')?.getAttribute('opacity'), '1');
  assert.equal(root.querySelectorAll('.bodygraph-channels [data-highlight-gate]').length, 3);
});

test('glow masks and pinned integration colors are bounded to their visible contour', () => {
  const document = svgDocument(), root = document.createElementNS(SVG_NS, 'svg');
  root.innerHTML = renderBodygraph(chart, { type: 'center', id: 'throat' }, { highlightStyle: 'glow' });
  const center = root.querySelector('[data-type="center"][data-id="throat"] .bg-center-highlight')!;
  const mask = root.querySelector(center.getAttribute('mask')!.slice(4, -1))!;
  assert.ok(Number(mask.getAttribute('width')) < 200 && Number(mask.getAttribute('height')) < 200, 'center cutout must be as local as its blur');
  const integration = root.querySelector('.bodygraph-integration-highlights')!;
  const filter = root.querySelector(integration.getAttribute('filter')!.slice(4, -1))!;
  for (const node of [...root.querySelectorAll('mask').filter(n => n.id.includes('integration')), ...root.querySelectorAll('.bg-integration-color-defs pattern')]) {
    for (const dimension of ['x', 'y', 'width', 'height']) assert.equal(node.getAttribute(dimension), filter.getAttribute(dimension), `${node.id}: ${dimension}`);
  }
});

test('local highlight color tiles keep source geometry in chart coordinates', () => {
  const document = svgDocument(), root = document.createElementNS(SVG_NS, 'svg');
  root.innerHTML = renderBodygraph(chart, { type: 'center', id: 'g' }, { highlightStyle: 'glow' });
  for (const pattern of root.querySelectorAll('pattern')) {
    const bounds = ['x', 'y', 'width', 'height'].map(name => pattern.getAttribute(name)).join(' ');
    assert.equal(pattern.getAttribute('viewBox'), bounds, 'a tile with a nonzero origin must explicitly map its chart-space contents');
  }
});


test('mutating activation arrays still repaints physical channels without replacing targets', () => {
  const document = svgDocument(), root = document.createElementNS(SVG_NS, 'svg');
  const renderer = createSceneRenderer(root), mutable = { personality: [20], design: [34] };
  const options = { highlightStyle: 'glow' as const };
  renderer.update(mutable, null, options);
  const target = root.querySelector('[data-type="gate"][data-id="10"]');
  mutable.personality.push(10, 57, 1, 8); mutable.design.splice(0, 1);
  renderer.update(mutable, { type: 'gate', id: 10 }, options);
  const fresh = document.createElementNS(SVG_NS, 'svg');
  fresh.innerHTML = renderBodygraph(mutable, { type: 'gate', id: 10 }, options);
  for (const selector of ['.bodygraph-integration-paint', '.bodygraph-channels [data-type="channel"]', '.bodygraph-gates'])
    assert.deepEqual(root.querySelectorAll(selector).map(n => significantDOM(n)), fresh.querySelectorAll(selector).map(n => significantDOM(n)));
  assert.equal(root.querySelector('[data-type="gate"][data-id="10"]'), target);
});
