import test from 'node:test';
import assert from 'node:assert/strict';
import { SVG_NS, svgDocument, significantDOM, SvgElement, SvgText } from './helpers/svg-dom.ts';
import { renderBodygraph } from '../src/scene/bodygraph-svg.ts';
import { createRenderState } from '../src/scene/render-state.ts';
import { createBodygraphPainter } from '../src/scene/bodygraph-painter.ts';
import { GATES } from '../src/domain/topology.ts';
import { crossAtLongitude } from '../src/domain/mandala-cross.ts';

function render(chart, selection, options) {
  const document = svgDocument();
  const root = document.createElementNS(SVG_NS, 'svg');
  root.innerHTML = renderBodygraph(chart, selection, options);
  return { root, document };
}

function assertEquivalent(actual: SvgElement, expected: SvgElement) {
  for (const selector of ['.bodygraph-drawing', 'defs'] as const) {
    assert.deepEqual(significantDOM(actual.querySelector(selector)), significantDOM(expected.querySelector(selector)), selector);
  }
}

test('adding the opposite gate keeps canonical half order and the existing halo node', () => {
  const chart = { design: [], personality: [] };
  const initialOptions = { selections: [{ type: 'gate' as const, id: 1 }] };
  const { root } = render(chart, null, initialOptions);
  const painter = createBodygraphPainter(root, createRenderState(chart, null, initialOptions), initialOptions);
  const retained = root.querySelector('[data-highlight-gate="1"]');
  const options = { selections: [...initialOptions.selections, { type: 'gate' as const, id: 8 }] };
  painter.update(createRenderState(chart, null, options), options);
  const expected = render(chart, null, options).root;
  const order = (node: SvgElement) => [...node.querySelectorAll('[data-highlight-gate]')].map(half => half.getAttribute('data-highlight-gate'));
  assert.deepEqual(order(root), order(expected), 'halves use canonical order regardless of selection history');
  assert.equal(root.querySelector('[data-highlight-gate="1"]'), retained);
  assertEquivalent(root, expected);
});

test('newly created persistent integration and gate highlights retain native rings and namespaced masks', () => {
  const chart = { design: [20], personality: [31] }, initialOptions = { idPrefix: 'new-glow' };
  const { root } = render(chart, null, initialOptions);
  const painter = createBodygraphPainter(root, createRenderState(chart, null, initialOptions), initialOptions);
  for (const id of [20, 31, 1]) {
    const options = { ...initialOptions, previewSelection: { type: 'gate' as const, id } };
    painter.update(createRenderState(chart, null, options), options);
    const gate = root.querySelector(`.bodygraph-gates [data-id="${id}"]`)!;
    assert.equal(gate.querySelector('.bg-gate-glow')?.getAttribute('fill'), 'none');
    assert.equal(gate.querySelector('.bg-gate-glow')?.getAttribute('opacity'), '1');
    if (id === 20) {
      const selection = root.querySelector('.bg-integration-selection')!;
      assert.equal(selection.getAttribute('filter'), null, 'new path is masked without a blur filter');
      assert.equal(selection.getAttribute('stroke-width'), '16.06', 'dynamic selection uses the same exterior ring as static paint');
      assert.equal(selection.parentElement!.getAttribute('filter'), null);
      assert.equal(selection.parentElement!.getAttribute('mask'), 'url(#new-glow-highlight-exterior)');
    }
    if (id === 1) assert.equal(root.querySelector('[data-highlight-gate="1"]')?.getAttribute('mask'), 'url(#new-glow-highlight-exterior)');
    assertEquivalent(root, render(chart, null, options).root);
  }
  painter.update(createRenderState(chart, null, initialOptions), initialOptions);
  assertEquivalent(root, render(chart, null, initialOptions).root);
});

test('persistent body paint matches the static renderer across activations, previews and integration masks', () => {
  const initial = { design: [], personality: [] };
  const { root } = render(initial, null, {});
  const painter = createBodygraphPainter(root);
  const targets = [...root.querySelectorAll('[data-type]')];
  const scenarios = [
    { selection: null, options: {} },
    { selection: { type: 'gate' as const, id: 20 }, options: {} },
    { selection: { type: 'channel' as const, id: '57-20' }, options: { dimInactive: true } },
    { selection: { type: 'center' as const, id: 'g' }, options: {} },
    { selection: { type: 'integration' as const, id: 'integration' }, options: { dimInactive: true } },
    { selection: null, options: { selections: [{ type: 'gate' as const, id: 10 }, { type: 'gate' as const, id: 20 }, { type: 'gate' as const, id: 34 }] } },
    { selection: { type: 'gate' as const, id: 10 }, options: { previewSelection: { type: 'gate' as const, id: 57 } } },
    { selection: null, options: { selections: [], previewSelection: { type: 'mandala-cross' as const, cross: crossAtLongitude(302.1) } } },
    { selection: null, options: { selections: GATES.filter(gate => gate.center === 'root').map(gate => ({ type: 'gate' as const, id: gate.id })) } },
    { selection: null, options: { selections: [], dimInactive: true } },
  ];
  for (let step = 0; step < 30; step++) {
    const chart = { source: 'manual' as const,
      design: GATES.filter(({ id }) => [0, 1].includes((id + step) % 4)).map(gate => gate.id),
      personality: GATES.filter(({ id }) => [1, 2].includes((id + step) % 4)).map(gate => gate.id) };
    const { selection, options } = scenarios[step % scenarios.length];
    assert.equal(painter.update(createRenderState(chart, selection, options), options), true);
    assertEquivalent(root, render(chart, selection, options).root);
    const current = [...root.querySelectorAll('[data-type]')];
    assert.equal(current.length, targets.length);
    current.forEach((node, index) => assert.equal(node, targets[index], 'gate, center and channel targets retain focus identity'));
  }
  painter.update(createRenderState(initial, null, {}));
  assertEquivalent(root, render(initial, null, {}).root);
});

test('repeated body facts do not parse any paths or masks and do not replace targets', () => {
  const chart = { design: [10, 34], personality: [20, 57] }, options = { dimInactive: true };
  const { root, document } = render(chart, null, options);
  const painter = createBodygraphPainter(root);
  painter.update(createRenderState(chart, null, options), options);
  document.parses.length = 0;
  const snapshot = significantDOM(root);
  for (let i = 0; i < 10; i++) assert.equal(painter.update(createRenderState(chart, null, options), options), false);
  assert.deepEqual(document.parses, []);
  assert.deepEqual(significantDOM(root), snapshot);
});

const focusMasks = (root: SvgElement&SVGElement) => root.querySelectorAll('mask').filter((node: { id: string|string[]; }) => node.id.includes('-integration-focus-'));
function assertSameChildren(masks: { childNodes: unknown[]; }[], children: ((SvgElement|SvgText)&ChildNode)[][]) {
  masks.forEach((node: { childNodes: unknown[]; }, index: string|number) => {
    assert.equal(node.childNodes.length, children[index].length);
    node.childNodes.forEach((child: unknown, position: string|number) => assert.equal(child, children[index][position], 'mask child retains identity'));
  });
}

test('integration hover and selection retain focus-mask children through adopted and fresh painter mounts', () => {
  const chart = { design: [10, 34], personality: [20, 57] };
  const scenarios = [
    { previewSelection: { type: 'gate' as const, id: 20 } },
    { previewSelection: { type: 'gate' as const, id: 10 } },
    { previewSelection: { type: 'center' as const, id: 'sacral' } },
    { selections: [{ type: 'channel' as const, id: '20-34' }] },
    { selections: [{ type: 'integration' as const, id: 'integration' }], dimInactive: true },
    { selections: [{ type: 'gate' as const, id: 20 }], previewSelection: { type: 'gate' as const, id: 57 } },
    {},
  ];
  for (const adopted of [false, true] as const) for (const idPrefix of ['bodygraph', 'remounted'] as const) {
    const options = { idPrefix }, { root, document } = render(chart, null, options);
    const initialState = createRenderState(chart, null, options);
    const painter = createBodygraphPainter(root, adopted ? initialState : null, options);
    if (!adopted) painter.update(initialState, options);
    const masks = focusMasks(root);
    assert.equal(masks.length, 6);
    const children = masks.map(node => [...node.childNodes]);
    for (const scenario of scenarios) {
      const nextOptions = { ...options, ...scenario };
      document.parses.length = 0;
      painter.update(createRenderState(chart, null, nextOptions), nextOptions);
      assertEquivalent(root, render(chart, null, nextOptions).root);
      assert.equal(document.parses.filter(entry => masks.includes(entry.target)).length, 0,
        'selection changes never parse a fixed focus route');
      assertSameChildren(masks, children);
    }
  }
});

test('focus masks follow every inactive, personality, design and dual-source integration combination', () => {
  const integrationGates = [20, 10, 34, 57];
  const initial = { personality: [], design: [] }, baseOptions = { idPrefix: 'activation-mask' };
  const { root, document } = render(initial, null, baseOptions);
  const painter = createBodygraphPainter(root, createRenderState(initial, null, baseOptions), baseOptions);
  const masks = focusMasks(root);
  let previousActive = '', previousChildren = masks.map(node => [...node.childNodes]);
  for (let combination = 0; combination < 256; combination++) {
    const chart = { personality: [], design: [] };
    integrationGates.forEach((gate, index) => {
      const state = combination >> (index * 2) & 3;
      if (state & 1) chart.personality.push(gate);
      if (state & 2) chart.design.push(gate);
    });
    const active = integrationGates.filter(gate => chart.personality.includes(gate) || chart.design.includes(gate)).join(',');
    const options = { ...baseOptions, dimInactive: Boolean(combination % 2),
      selections: [{ type: 'gate' as const, id: integrationGates[combination % 4] }],
      previewSelection: { type: 'gate' as const, id: integrationGates[(combination + 1) % 4] } };
    document.parses.length = 0;
    painter.update(createRenderState(chart, null, options), options);
    assertEquivalent(root, render(chart, null, options).root);
    if (active === previousActive) {
      assert.equal(document.parses.filter(entry => masks.includes(entry.target)).length, 0,
        'changing personality/design ownership alone cannot change an occlusion mask');
      assertSameChildren(masks, previousChildren);
    }
    previousActive = active;
    previousChildren = masks.map(node => [...node.childNodes]);
  }
});

test('center to gate preview retains the shared ordinary half halo node', () => {
  const chart = { design: [], personality: [] };
  const initialOptions = { previewSelection: { type: 'center' as const, id: 'g' } };
  const { root } = render(chart, null, initialOptions);
  const painter = createBodygraphPainter(root, createRenderState(chart, null, initialOptions), initialOptions);
  const shared = root.querySelector('[data-highlight-gate="1"]');
  assert.ok(shared);
  const options = { previewSelection: { type: 'gate' as const, id: 1 } };
  painter.update(createRenderState(chart, null, options), options);
  assert.equal(root.querySelector('[data-highlight-gate="1"]'), shared, 'shared highlight remains continuously painted');
});

test('integration outgoing paint keeps its old mask and remains bounded during rapid changes', () => {
  const chart = { design: [], personality: [] };
  const options = { previewSelection: { type: 'gate' as const, id: 10 } };
  const { root, document } = render(chart, null, options);
  const animations: Animation[] = [];
  Object.assign(document, { defaultView: { matchMedia: () => ({ matches: false }), getComputedStyle: node => ({ opacity: node.getAttribute('opacity') ?? '1' }) } });
  root.animate = () => ({ cancel() {}, onfinish: null } as unknown as Animation);
  const create = document.createElementNS.bind(document);
  document.createElementNS = (ns, tag) => {
    const node = create(ns, tag);
    node.animate = () => { const animation = { cancel() {}, onfinish: null } as unknown as Animation; animations.push(animation); return animation; };
    return node;
  };
  for (const node of root.querySelectorAll('path')) node.animate = () => { const animation = { cancel() {}, onfinish: null } as unknown as Animation; animations.push(animation); return animation; };
  const painter = createBodygraphPainter(root, createRenderState(chart, null, options), options);
  const oldMask = root.querySelector('mask[id="bodygraph-integration-selection-outline"]')!.innerHTML;
  const change = id => { const next = { previewSelection: { type: 'gate' as const, id } }; painter.update(createRenderState(chart, null, next), next); };
  change(20);
  const outgoing = root.querySelector('[data-soft-highlight-outgoing="paint"]');
  assert.ok(outgoing, 'old geometry remains during exit');
  const mask = root.querySelector('[data-soft-highlight-outgoing="mask"]');
  assert.ok(mask);
  assert.equal(mask.innerHTML, oldMask, 'outgoing arm retains its own occlusion');
  assert.equal(outgoing.getAttribute('mask'), `url(#${mask.id})`);
  assert.equal(outgoing.getAttribute('filter'), null, 'retiring geometry keeps its exact mask without a blur filter');
  assert.equal(outgoing.parentElement!.getAttribute('filter'), null, 'retiring geometry does not introduce blur');
  for (const gate of [34, 57, 10, 20]) {
    change(gate);
    assert.equal(root.querySelectorAll('[data-soft-highlight-outgoing="paint"]').length, 1);
    assert.equal(root.querySelectorAll('[data-soft-highlight-outgoing="mask"]').length, 1);
  }
  for (const animation of animations) animation.onfinish?.({} as AnimationPlaybackEvent);
  assert.equal(root.querySelectorAll('[data-soft-highlight-outgoing]').length, 0);
});

test('rapid integration geometry changes cancel the previous enter effect on the retained path', () => {
  const chart = { design: [], personality: [] }, options = { previewSelection: { type: 'gate' as const, id: 10 } };
  const { root, document } = render(chart, null, options);
  let active = 0;
  Object.assign(document, { defaultView: { matchMedia: () => ({ matches: false }), getComputedStyle: () => ({ opacity: '0.5' }) } });
  root.animate = () => ({ cancel() {}, onfinish: null } as unknown as Animation);
  const create = document.createElementNS.bind(document);
  document.createElementNS = (ns, tag) => { const node = create(ns, tag); node.animate = () => ({ cancel() {}, onfinish: null } as unknown as Animation); return node; };
  const path = root.querySelector('.bg-integration-selection')!;
  path.animate = (_frames, options) => {
    assert.equal((options as KeyframeAnimationOptions).duration, 92, 'retained integration geometry enters with the shared duration');
    active++; let cancelled = false; return { cancel() { if (!cancelled) { cancelled = true; active--; } }, onfinish: null } as unknown as Animation;
  };
  const painter = createBodygraphPainter(root, createRenderState(chart, null, options), options);
  for (const id of [20, 34, 57, 10]) {
    const next = { previewSelection: { type: 'gate' as const, id } };
    painter.update(createRenderState(chart, null, next), next);
    assert.equal(active, 1, 'one enter effect belongs to the current integration geometry');
  }
});

test('integration re-entry reclaims the exiting contour and its current opacity', () => {
  const chart = { design: [], personality: [] }, options = { previewSelection: { type: 'gate' as const, id: 10 } };
  const { root, document } = render(chart, null, options);
  const frames: Keyframe[][] = [];
  const durations: number[] = [];
  Object.assign(document, { defaultView: { matchMedia: () => ({ matches: false }), getComputedStyle: () => ({ opacity: '0.4' }) } });
  root.animate = () => ({ cancel() {}, onfinish: null } as unknown as Animation);
  const create = document.createElementNS.bind(document);
  document.createElementNS = (ns, tag) => { const node = create(ns, tag); node.animate = (values, settings) => { frames.push(values as Keyframe[]); durations.push((settings as KeyframeAnimationOptions).duration as number); return { cancel() {}, onfinish: null } as unknown as Animation; }; return node; };
  root.querySelector('.bg-integration-selection')!.animate = () => ({ cancel() {}, onfinish: null } as unknown as Animation);
  const painter = createBodygraphPainter(root, createRenderState(chart, null, options), options);
  painter.update(createRenderState(chart, null, {}), {});
  const retiring = root.querySelector('[data-soft-highlight-outgoing="paint"]');
  painter.update(createRenderState(chart, null, options), options);
  assert.ok(root.querySelector('.bg-integration-selection') === retiring, 'same contour is reclaimed during exit');
  assert.equal(frames.at(-1)![0].opacity, '0.4', 're-entry continues from current paint');
  assert.equal(root.querySelectorAll('[data-soft-highlight-outgoing]').length, 0);
  assert.deepEqual(durations, [69, 92], 'outgoing and reclaimed integration paint use the shared 15% longer timing');
});
