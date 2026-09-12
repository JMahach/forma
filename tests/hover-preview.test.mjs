import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { attachHoverPreview } from '../src/selection/hover-preview.js';
import { renderBodygraph } from '../src/bodygraph/bodygraph.js';
import { alignPersonalityHeading } from '../src/activations/activations.js';
import { createSelectionState } from '../src/selection/selection-state.js';
import { CENTERS, GATES } from '../src/bodygraph/graph-data.js';
import { STEM_POINTS } from '../src/bodygraph/integration-geometry.js';

function hoverHarness(t) {
  const originals = new Map(['document', 'window'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  t.after(() => {
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
    }
  });
  const listeners = new Map(), previews = [], classes = new Set();
  let previewHandler;
  const addListener = surface => (type, callback) => {
    const key = `${surface}:${type}`;
    if (!listeners.has(key)) listeners.set(key, []);
    listeners.get(key).push(callback);
  };
  const document = { hidden: false, visibilityState: 'visible', addEventListener: addListener('document') };
  const window = { addEventListener: addListener('window') };
  Object.defineProperty(globalThis, 'document', { configurable: true, writable: true, value: document });
  Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: window });
  const svg = {
    addEventListener: addListener('svg'),
    classList: { contains: name => classes.has(name) },
    contains(target) { return target?.insideSvg === true; },
  };
  function node(dataset = {}, { insideSvg = true, parent = null } = {}) {
    return {
      dataset, insideSvg, parent,
      closest(selector) {
        let matches = true;
        for (const [, rawKey, expected] of selector.matchAll(/\[data-([a-z-]+)(?:=["']([^"']+)["'])?\]/g)) {
          const key = rawKey.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
          if (!Object.hasOwn(dataset, key) || expected !== undefined && dataset[key] !== expected) matches = false;
        }
        return matches ? this : this.parent?.closest(selector) || null;
      },
    };
  }
  const target = (type, id, activation) => node({ type, id: String(id), ...(activation ? { activation } : {}) });
  function send(surface, type, options = {}) {
    const event = {
      target: svg, relatedTarget: null, pointerType: 'mouse', pointerId: 1, buttons: 0, button: 0,
      defaultPrevented: false, propagationStopped: false,
      preventDefault() { this.defaultPrevented = true; },
      stopPropagation() { this.propagationStopped = true; },
      ...options,
    };
    for (const callback of listeners.get(`${surface}:${type}`) || []) callback(event);
    return event;
  }
  const controller = attachHoverPreview(svg, { onPreview(selection) { previews.push(selection); previewHandler?.(selection); } });
  const move = (target, options = {}) => send('svg', 'pointermove', { target, ...options });
  return { controller, svg, document, previews, classes, listeners, node, target, send, move, setPreviewHandler(handler) { previewHandler = handler; } };
}

test('pointer movement previews numeric activations, diagram gates, centers, channels and integration', t => {
  const harness = hoverHarness(t);
  assert.equal(harness.controller.currentSelection, null);
  for (const [type, id, activation] of [
    ['gate', 41, 'personality-mercury'], ['gate', 19, 'design-sun'], ['gate', 37],
    ['center', 'throat'], ['channel', '37-40'], ['integration', 'integration'],
  ]) {
    const selection = { type, id };
    harness.move(harness.target(type, id, activation));
    assert.deepEqual(harness.controller.currentSelection, selection);
    assert.deepEqual(harness.previews.at(-1), selection, 'preview uses the same normalized selection as clicking');
  }
  harness.send('svg', 'pointerleave');
  assert.equal(harness.controller.currentSelection, null);
  assert.equal(harness.previews.at(-1), null, 'leaving signals restoration of the committed selection');
});

test('same-gate copies and descendants deduplicate preview notifications regardless of source or planet', t => {
  const harness = hoverHarness(t);
  const first = harness.target('gate', 41, 'personality-mercury');
  harness.move(first);
  for (const target of [
    harness.node({}, { parent: first }), first,
    harness.target('gate', 41, 'personality-mars'),
    harness.target('gate', 41, 'design-sun'),
    harness.target('gate', 41),
  ]) harness.move(target);
  assert.deepEqual(harness.previews, [{ type: 'gate', id: 41 }]);
  assert.deepEqual(harness.controller.currentSelection, { type: 'gate', id: 41 });
});

test('the controller has no pointerover or pointerout handlers, so SVG replacement cannot create a hover loop', t => {
  const harness = hoverHarness(t);
  assert.equal(harness.listeners.has('svg:pointerover'), false);
  assert.equal(harness.listeners.has('svg:pointerout'), false);
  harness.move(harness.target('center', 'throat'));
  for (let i = 0; i < 10; i++) {
    const replacement = harness.target('center', 'throat');
    harness.send('svg', 'pointerout', { target: replacement });
    harness.send('svg', 'pointerover', { target: replacement });
    harness.move(replacement);
  }
  assert.deepEqual(harness.previews, [{ type: 'center', id: 'throat' }], 'equivalent nodes created by redraw keep a single preview');
});

test('touch, pressed pointers, planets and malformed gates do not preview', t => {
  const harness = hoverHarness(t), number = harness.target('gate', 41, 'personality-mercury');
  for (const options of [{ pointerType: 'touch' }, { buttons: 1 }, { buttons: 2 }]) harness.move(number, options);
  for (const target of [
    harness.target('planet', 'design-mercury', 'design-mercury-planet'),
    harness.target('gate', 0), harness.target('gate', 65), harness.target('gate', 1.5), harness.target('gate', 'invalid'),
    harness.target('unknown', 'anything'), harness.node({}),
  ]) harness.move(target);
  assert.equal(harness.controller.currentSelection, null);
  assert.deepEqual(harness.previews, []);
});

test('clicking without movement preserves hover and leaves the click available to pin or unpin', t => {
  const harness = hoverHarness(t), target = harness.target('center', 'throat');
  harness.move(target);
  for (const type of ['pointerdown', 'pointerup', 'click']) {
    const event = harness.send('svg', type, { target, buttons: type === 'pointerdown' ? 1 : 0 });
    assert.deepEqual(harness.controller.currentSelection, { type: 'center', id: 'throat' });
    assert.equal(event.defaultPrevented, false);
    assert.equal(event.propagationStopped, false);
  }
  assert.deepEqual(harness.previews, [{ type: 'center', id: 'throat' }]);
  harness.send('svg', 'pointerleave');
  assert.deepEqual(harness.previews, [{ type: 'center', id: 'throat' }, null]);
});

test('moving with a pressed pointer or while dragging clears the preview and blocks its return during the drag', t => {
  const harness = hoverHarness(t), target = harness.target('gate', 41, 'personality-mercury');
  harness.move(target);
  harness.move(target, { buttons: 1 });
  assert.equal(harness.controller.currentSelection, null);
  harness.classes.add('is-dragging');
  harness.move(target);
  assert.deepEqual(harness.previews, [{ type: 'gate', id: 41 }, null]);
  harness.classes.delete('is-dragging');
  harness.move(target);
  assert.deepEqual(harness.controller.currentSelection, { type: 'gate', id: 41 });
});

test('background movement, leave, wheel, blur and hidden-document events restore the committed display once', t => {
  const harness = hoverHarness(t), target = harness.target('center', 'solar');
  for (const dismiss of [
    () => harness.move(harness.node({})),
    () => harness.send('svg', 'pointerleave'),
    () => harness.send('svg', 'wheel'),
    () => harness.send('window', 'blur'),
    () => { harness.document.hidden = true; harness.document.visibilityState = 'hidden'; harness.send('document', 'visibilitychange'); },
  ]) {
    harness.document.hidden = false; harness.document.visibilityState = 'visible';
    harness.move(target);
    const before = harness.previews.length;
    dismiss();
    assert.equal(harness.controller.currentSelection, null);
    assert.equal(harness.previews.length, before + 1);
    assert.equal(harness.previews.at(-1), null);
    dismiss();
    assert.equal(harness.previews.length, before + 1, 'repeated cleanup does not redraw twice');
  }
});

test('clear can silently reset preview state for a normal redraw', t => {
  const harness = hoverHarness(t);
  harness.move(harness.target('gate', 41));
  harness.controller.clear({ notify: false });
  assert.equal(harness.controller.currentSelection, null);
  assert.deepEqual(harness.previews, [{ type: 'gate', id: 41 }]);
  harness.controller.clear();
  assert.deepEqual(harness.previews, [{ type: 'gate', id: 41 }], 'clearing an empty preview is harmless');
});

const chartFixture = () => ({
  personality: [1, 10, 20, 29, 34, 37, 41, 57], design: [1, 19, 20, 29, 40, 41],
  activations: {
    personality: [
      { planet: 'sun', gate: 41, line: 1 }, { planet: 'mercury', gate: 41, line: 2 }, { planet: 'mars', gate: 37, line: 3 },
      { planet: 'earth', gate: 20, line: 1 }, { planet: 'moon', gate: 20, line: 2 },
      { planet: 'venus', gate: 1, line: 3 }, { planet: 'jupiter', gate: 29, line: 4 },
    ],
    design: [
      { planet: 'sun', gate: 41, line: 4 }, { planet: 'earth', gate: 19, line: 5 },
      { planet: 'moon', gate: 20, line: 3 }, { planet: 'mercury', gate: 20, line: 4 },
      { planet: 'mars', gate: 29, line: 5 }, { planet: 'venus', gate: 1, line: 6 },
    ],
  },
});

const withoutPressed = markup => markup.replace(/ aria-pressed="(?:true|false)"/g, '');
const pressed = markup => [...markup.matchAll(/<g\b[^>]*data-type="([^"]+)"[^>]*data-id="([^"]+)"[^>]*aria-pressed="true"[^>]*>/g)]
  .map(([, type, id]) => `${type}:${id}`).sort();

test('unpinned gate hover uses the exact click paint for every gate, including its own channel halves and integration', () => {
  const chart = chartFixture(), pinned = null;
  const before = JSON.stringify({ chart, pinned });
  for (const gate of GATES) {
    const preview = { type: 'gate', id: gate.id };
    const hovered = renderBodygraph(chart, pinned, { showActivations: true, previewSelection: preview });
    const clicked = renderBodygraph(chart, preview, { showActivations: true });
    assert.equal(withoutPressed(hovered), withoutPressed(clicked), `gate ${gate.id} keeps exactly its click appearance`);
    assert.deepEqual(pressed(hovered), pressed(renderBodygraph(chart, pinned, { showActivations: true })), 'hover does not change the committed accessible selection');
  }
  assert.equal(JSON.stringify({ chart, pinned }), before);
});

test('unpinned center, channel and integration hover paint matches click paint without creating a committed selection', () => {
  const chart = chartFixture(), pinned = null;
  for (const preview of [
    ...CENTERS.map(center => ({ type: 'center', id: center.id })),
    { type: 'channel', id: '37-40' }, { type: 'channel', id: '10-20' }, { type: 'integration', id: 'integration' },
  ]) {
    const hovered = renderBodygraph(chart, pinned, { showActivations: true, previewSelection: preview });
    const clicked = renderBodygraph(chart, preview, { showActivations: true });
    assert.equal(withoutPressed(hovered), withoutPressed(clicked), `${preview.type} ${preview.id} matches its click appearance`);
    assert.deepEqual(pressed(hovered), pressed(renderBodygraph(chart, pinned, { showActivations: true })));
  }
});

test('hover highlights every numeric copy of a gate across both columns without changing their pressed state', () => {
  const chart = chartFixture();
  const markup = renderBodygraph(chart, null, { showActivations: true, previewSelection: { type: 'gate', id: 41 } });
  const rows = [...markup.matchAll(/<g class="bg-activation"[^>]*data-id="([^"]+)"[^>]*data-activation="([^"]+)"[^>]*>([\s\S]*?)<\/g>/g)];
  assert.equal(rows.length, chart.activations.personality.length + chart.activations.design.length);
  for (const [whole, gate, id, content] of rows) {
    assert.match(content, new RegExp(`fill="${gate === '41' ? '#eaf0f8' : 'transparent'}"`), `${id} follows the hovered gate number`);
    assert.match(whole, /aria-pressed="false"/, `${id} remains unpinned`);
  }
  assert.deepEqual(pressed(markup), []);
});

test('ending a preview restores the committed paint, including an empty selection', () => {
  const chart = chartFixture();
  for (const pinned of [null, { type: 'gate', id: 37 }, { type: 'center', id: 'throat' }, { type: 'channel', id: '37-40' }]) {
    const baseline = renderBodygraph(chart, pinned, { showActivations: true });
    const hovered = renderBodygraph(chart, pinned, { showActivations: true, previewSelection: { type: 'gate', id: 41 } });
    assert.notEqual(hovered, baseline);
    assert.equal(renderBodygraph(chart, pinned, { showActivations: true, previewSelection: null }), baseline);
  }
});

function visibleHighlights(markup) {
  const starts = [...markup.matchAll(/<g data-type="([^"]+)" data-id="([^"]+)"[^>]*>/g)];
  const groups = starts.map((match, index) => ({ type: match[1], id: match[2], attributes: match[0], content: markup.slice(match.index, starts[index + 1]?.index ?? markup.length) }));
  const integrationPath = markup.match(/<path class="bg-integration-selection" d="([^"]+)"/)?.[1] || '';
  return {
    gates: new Set(groups.filter(group => group.type === 'gate' && /data-related="true"/.test(group.attributes)).map(group => group.id)),
    centers: new Set(groups.filter(group => group.type === 'center' && /<path class="bg-center-highlight"[^>]*opacity="1"/.test(group.content)).map(group => group.id)),
    channels: new Set(groups.filter(group => group.type === 'channel' && /<path class="bg-channel-highlight"[^>]*opacity="1"/.test(group.content)).map(group => group.id)),
    relatedChannels: new Set(groups.filter(group => group.type === 'channel' && /data-related="true"/.test(group.attributes)).map(group => group.id)),
    halfPaths: new Set(groups.filter(group => group.type === 'channel').flatMap(group => [...group.content.matchAll(/<g data-highlight-gate="(\d+)">(<path[^>]*\/>)/g)].map(([, gate, path]) => `${group.id}:${gate}:${path}`))),
    integrationPaths: new Set(integrationPath.split(/(?=M)/).map(path => path.trim()).filter(Boolean)),
    numericCopies: new Set([...markup.matchAll(/<g class="bg-activation"[^>]*data-activation="([^"]+)"[^>]*data-selected="true"/g)].map(([, id]) => id)),
  };
}

function assertVisualUnion(chart, pinned, preview) {
  const options = { showActivations: true };
  const pinnedMarkup = renderBodygraph(chart, pinned, options), previewMarkup = renderBodygraph(chart, preview, options);
  const markup = renderBodygraph(chart, pinned, { ...options, previewSelection: preview });
  const actual = visibleHighlights(markup), base = visibleHighlights(pinnedMarkup), extra = visibleHighlights(previewMarkup);
  const fullChannels = new Set([...base.channels, ...extra.channels]);
  const ownedGates = new Set([pinned, preview].flatMap(value => value?.type === 'gate' ? [Number(value.id)]
    : value?.type === 'center' ? GATES.filter(gate => gate.center === value.id).map(gate => gate.id) : []));
  const connectsIntegrationStem = [10, 20].some(id => ownedGates.has(id)) && [34, 57].some(id => ownedGates.has(id));
  for (const key of Object.keys(actual)) {
    const combined = [...base[key], ...extra[key]];
    // A selected whole channel already paints both halves; it should not add a
    // duplicate half overlay when its endpoint is also hovered.
    const expected = new Set(key === 'halfPaths' ? combined.filter(path => !fullChannels.has(path.split(':')[0])) : combined);
    if (key === 'integrationPaths' && connectsIntegrationStem) expected.add(stemPath);
    assert.deepEqual(actual[key], expected, `${key} adds the hovered highlight while retaining the pinned one`);
  }
  assert.deepEqual(pressed(markup), pressed(pinnedMarkup), 'only the committed selection remains pressed');
  return markup;
}

test('a pinned throat keeps every center, gate and half-channel highlight while gate 1, 20 or 29 is hovered', () => {
  const chart = chartFixture(), pinned = Object.freeze({ type: 'center', id: 'throat' });
  const snapshot = JSON.stringify({ chart, pinned });
  for (const id of [1, 20, 29]) {
    const markup = assertVisualUnion(chart, pinned, { type: 'gate', id });
    assert.deepEqual(visibleHighlights(markup).centers, new Set(['throat']));
    assert.deepEqual(visibleHighlights(markup).gates, new Set([...GATES.filter(gate => gate.center === 'throat').map(gate => String(gate.id)), String(id)]));
  }
  assert.equal(JSON.stringify({ chart, pinned }), snapshot, 'hover does not modify chart or pinned selection data');
});

test('center-plus-center and channel-plus-gate previews preserve both independent highlight scopes', () => {
  const chart = chartFixture();
  for (const [pinned, preview] of [
    [{ type: 'center', id: 'throat' }, { type: 'center', id: 'sacral' }],
    [{ type: 'center', id: 'throat' }, { type: 'center', id: 'throat' }],
    [{ type: 'gate', id: 29 }, { type: 'center', id: 'throat' }],
    [{ type: 'channel', id: '37-40' }, { type: 'gate', id: 29 }],
    [{ type: 'channel', id: '37-40' }, { type: 'gate', id: 37 }],
    [{ type: 'gate', id: 29 }, { type: 'channel', id: '37-40' }],
    [{ type: 'gate', id: 29 }, { type: 'gate', id: 29 }],
  ]) assertVisualUnion(chart, pinned, preview);
});

test('additive column highlights keep all repeated throat gate 20 copies and add every hovered gate 29 copy', () => {
  const chart = chartFixture(), pinned = { type: 'center', id: 'throat' };
  const markup = assertVisualUnion(chart, pinned, { type: 'gate', id: 29 });
  const rows = [...markup.matchAll(/<g class="bg-activation"[^>]*data-id="([^"]+)"[^>]*data-activation="([^"]+)"[^>]*>([\s\S]*?)<\/g>/g)];
  const throatGates = new Set(GATES.filter(gate => gate.center === 'throat').map(gate => gate.id));
  for (const [whole, gate, id, content] of rows) {
    const pinnedCopy = throatGates.has(Number(gate)), lit = pinnedCopy || gate === '29';
    assert.match(content, new RegExp(`fill="${lit ? '#eaf0f8' : 'transparent'}"`), `${id} uses additive numeric highlighting`);
    assert.match(whole, new RegExp(`aria-pressed="${pinnedCopy}"`), `${id} distinguishes the committed gate from the hovered gate`);
  }
  assert.equal(rows.filter(([, gate]) => gate === '20').length, 4, 'gate 20 repeats in both sources');
  assert.equal(rows.filter(([, gate]) => gate === '29').length, 2, 'hovered gate 29 is present in both sources');
});

test('channel-endpoint previews do not infer another integration connection with a gate or center', () => {
  const chart = chartFixture();
  for (const [pinned, preview] of [
    [{ type: 'channel', id: '10-20' }, { type: 'gate', id: 57 }],
    [{ type: 'channel', id: '10-20' }, { type: 'center', id: 'spleen' }],
    [{ type: 'center', id: 'throat' }, { type: 'channel', id: '34-57' }],
    [{ type: 'gate', id: 20 }, { type: 'channel', id: '34-57' }],
  ]) {
    const markup = assertVisualUnion(chart, pinned, preview);
    const mask = markup.match(/<mask id="bodygraph-integration-selection-outline"[^>]*>([\s\S]*?)<\/mask>/)?.[1];
    assert.ok(mask, 'partial integration highlights retain their ownership mask');
    assert.doesNotMatch(mask, /class="bg-integration-owned-stem"/, 'related endpoints do not infer a selected gate pair');
    assert.equal(visibleHighlights(markup).integrationPaths.has(stemPath), false);
    assert.match(markup, /data-junction="integration" data-visual-selected="false"/, 'independent arms do not become a whole-integration selection');
  }
});

const stemPath = STEM_POINTS.map(([x, y], index) => `${index ? 'L' : 'M'}${x.toFixed(2)},${y.toFixed(2)}`).join(' ');

test('hovering an individual integration partner previews the exact connecting channel without pressing it', () => {
  const chart = chartFixture();
  for (const [first, second] of [[20, 57], [57, 20], [10, 34], [34, 10]]) {
    const pinned = { type: 'gate', id: first }, preview = { type: 'gate', id: second };
    const markup = assertVisualUnion(chart, pinned, preview);
    const explicit = renderBodygraph(chart, { type: 'channel', id: [first, second].sort((a, b) => a - b).join('-') }, { showActivations: true });
    assert.deepEqual(visibleHighlights(markup).integrationPaths, visibleHighlights(explicit).integrationPaths);
    assert.equal(visibleHighlights(markup).integrationPaths.has(stemPath), true);
    assert.deepEqual(pressed(markup), pressed(renderBodygraph(chart, pinned, { showActivations: true })));
    assert.match(markup, /data-junction="integration" data-visual-selected="false"/);
  }
});

test('an explicit cross-node channel or whole integration contributes its stem exactly once to an additive preview', () => {
  const chart = chartFixture();
  for (const [pinned, preview] of [
    [{ type: 'channel', id: '20-57' }, { type: 'gate', id: 10 }],
    [{ type: 'gate', id: 57 }, { type: 'channel', id: '20-34' }],
    [{ type: 'channel', id: '20-57' }, { type: 'channel', id: '10-34' }],
    [{ type: 'integration', id: 'integration' }, { type: 'gate', id: 29 }],
    [{ type: 'center', id: 'throat' }, { type: 'integration', id: 'integration' }],
  ]) {
    const markup = assertVisualUnion(chart, pinned, preview);
    const integrationPath = markup.match(/<path class="bg-integration-selection" d="([^"]+)"/)?.[1];
    assert.ok(integrationPath);
    const paths = integrationPath.split(/(?=M)/).map(path => path.trim()).filter(Boolean);
    assert.equal(paths.length, new Set(paths).size, 'shared arms and the stem are not duplicated');
    assert.equal(paths.filter(path => path === stemPath).length, 1, 'the explicit crossing channel contributes the common stem exactly once');
    const whole = pinned.type === 'integration' || preview.type === 'integration';
    if (!whole) {
      const mask = markup.match(/<mask id="bodygraph-integration-selection-outline"[^>]*>([\s\S]*?)<\/mask>/)?.[1];
      const wholeExterior = /<rect[^>]*fill="#ffffff"/.test(mask);
      assert.ok(wholeExterior || /class="bg-integration-owned-stem"/.test(mask), 'the ownership mask permits the explicit stem, including a complete union of both crossing channels');
    }
  }
});

function graphHarness(t, selection, selectedActivation = null) {
  const hover = hoverHarness(t), chart = { ...chartFixture(), id: 'hover-chart' };
  const app = readFileSync(new URL('../src/app.js', import.meta.url), 'utf8');
  const sources = ['renderGraph', 'choose'].map(name => {
    const source = app.match(new RegExp(`^function ${name}\\([^)]*\\) \\{[\\s\\S]*?^\\}`, 'm'))?.[0];
    assert.ok(source, `${name} is available to test without bootstrapping the app`);
    return source;
  });
  const viewport = { innerHTML: '', querySelector() { return null; } };
  const popupCalls = { show: 0, close: 0, refresh: 0 };
  const activationPopover = {
    currentId: selectedActivation,
    show(_chart, id) { this.currentId = id; popupCalls.show++; },
    close() { this.currentId = null; popupCalls.close++; },
    refresh() { popupCalls.refresh++; },
  };
  const selectionState = createSelectionState();
  if (selection) selectionState.choose({ ...selection, ...(selectedActivation ? { activation: selectedActivation } : {}) });
  const context = createContext({
    selectionState,
    get selection() { return selectionState.primary; },
    get selectedActivation() { return selectionState.activation; },
    get selectedItems() { return selectionState.items; },
    savedCharts: [chart], selectedChartId: chart.id, chart: () => chart,
    hoverPreview: hover.controller, activationPopover, renderBodygraph, alignPersonalityHeading,
    document: { activeElement: null },
    $: id => { assert.equal(id, 'viewport', 'preview only redraws the graph'); return viewport; },
  });
  runInContext(`${sources.join('\n')}\nglobalThis.render = renderGraph; globalThis.select = choose;`, context);
  hover.setPreviewHandler(() => context.render());
  context.render();
  return { hover, chart, viewport, popupCalls, activationPopover, context };
}

test('actual hover redraws preserve the pinned selection and popup state, then restore pinned paint on leave', t => {
  const harness = graphHarness(t, Object.freeze({ type: 'gate', id: 37 }), 'personality-mars');
  const pinned = Object.freeze(harness.context.selection);
  const baseline = harness.viewport.innerHTML;
  for (const [type, id, activation] of [['gate', 41, 'design-sun'], ['center', 'throat'], ['channel', '37-40'], ['integration', 'integration']]) {
    harness.hover.move(harness.hover.target(type, id, activation));
    assert.equal(harness.context.selection, pinned);
    assert.equal(harness.context.selectedActivation, 'personality-mars');
    assert.equal(harness.activationPopover.currentId, 'personality-mars', 'hover never replaces an open activation popup');
    assert.equal(harness.popupCalls.show, 0);
    assert.equal(harness.popupCalls.close, 0);
    assert.equal(harness.viewport.innerHTML, renderBodygraph(harness.chart, pinned, { showActivations: true, previewSelection: { type, id } }));
  }
  harness.hover.send('svg', 'pointerleave');
  assert.equal(harness.viewport.innerHTML, baseline);
  assert.equal(harness.context.selection, pinned);
});

test('clicking an additive gate or center preview replaces the pinned selection and leaving keeps only the new selection', t => {
  const harness = graphHarness(t, Object.freeze({ type: 'center', id: 'throat' }));
  const pinned = Object.freeze(harness.context.selection);
  const baseline = harness.viewport.innerHTML;
  for (const id of [1, 20, 29]) {
    harness.hover.move(harness.hover.target('gate', id, id === 29 ? 'design-mars' : undefined));
    assert.deepEqual(visibleHighlights(harness.viewport.innerHTML).centers, new Set(['throat']), 'the pinned center remains visible before clicking');
    assert.equal(harness.context.selection, pinned);
    assert.equal(harness.popupCalls.show, 0, 'additive hover alone opens no popup');
    harness.hover.send('svg', 'pointerleave');
    assert.equal(harness.viewport.innerHTML, baseline, 'leaving before clicking restores the original pinned center');
  }
  harness.hover.move(harness.hover.target('gate', 29, 'design-mars'));
  harness.context.select({ type: 'gate', id: '29', activation: 'design-mars' });
  assert.deepEqual(JSON.parse(JSON.stringify(harness.context.selection)), { type: 'gate', id: 29 });
  assert.equal(harness.context.selectedActivation, 'design-mars');
  assert.equal(harness.activationPopover.currentId, 'design-mars');
  assert.deepEqual(visibleHighlights(harness.viewport.innerHTML).centers, new Set(), 'clicking replaces the old center rather than accumulating selections');
  harness.hover.send('svg', 'pointerleave');
  assert.equal(harness.viewport.innerHTML, renderBodygraph(harness.chart, { type: 'gate', id: 29 }, { showActivations: true }));
  harness.hover.move(harness.hover.target('center', 'throat'));
  assert.equal(visibleHighlights(harness.viewport.innerHTML).gates.has('29'), true, 'a later center hover adds to the newly pinned gate');
  harness.context.select({ type: 'center', id: 'throat' });
  harness.hover.send('svg', 'pointerleave');
  assert.equal(harness.viewport.innerHTML, renderBodygraph(harness.chart, pinned, { showActivations: true }), 'clicking the center replaces the gate and leaving retains only that center');
  assert.equal(harness.activationPopover.currentId, null);
});

test('hover adds to every item in a multi-selection without reopening a popup or changing committed items', t => {
  const harness = graphHarness(t, null);
  harness.context.select({ type: 'gate', id: '20', activation: 'personality-earth' });
  harness.context.select({ type: 'gate', id: '29', activation: 'design-mars', additive: true });
  const committed = JSON.stringify(harness.context.selectedItems), baseline = harness.viewport.innerHTML;
  assert.equal(harness.activationPopover.currentId, null);
  assert.equal(harness.popupCalls.show, 1, 'only the first, single numeric selection opened a popup');
  for (const preview of [{ type: 'center', id: 'throat' }, { type: 'gate', id: 54 }]) {
    harness.hover.move(harness.hover.target(preview.type, preview.id));
    const visible = visibleHighlights(harness.viewport.innerHTML);
    assert.equal(visible.gates.has('20'), true);
    assert.equal(visible.gates.has('29'), true);
    assert.equal(JSON.stringify(harness.context.selectedItems), committed, 'hover cannot add or remove committed items');
    assert.deepEqual(pressed(harness.viewport.innerHTML), pressed(baseline));
    assert.equal(harness.activationPopover.currentId, null);
    assert.equal(harness.popupCalls.show, 1, 'hover does not reopen detail percentages while multiple items are selected');
    harness.hover.send('svg', 'pointerleave');
    assert.equal(harness.viewport.innerHTML, baseline, 'leaving restores the entire multi-selection');
  }
});

test('actual integration partner hover connects temporarily and Shift pinning or removal persists only the committed pair', t => {
  const harness = graphHarness(t, { type: 'gate', id: 20 });
  const baseline = harness.viewport.innerHTML, baselinePressed = pressed(baseline);
  assert.equal(visibleHighlights(baseline).integrationPaths.has(stemPath), false);
  harness.hover.move(harness.hover.target('gate', 57));
  assert.equal(visibleHighlights(harness.viewport.innerHTML).integrationPaths.has(stemPath), true);
  assert.deepEqual(pressed(harness.viewport.innerHTML), baselinePressed);
  assert.deepEqual(JSON.parse(JSON.stringify(harness.context.selectedItems)), [{ type: 'gate', id: 20 }]);
  assert.equal(harness.popupCalls.show, 0);
  harness.hover.send('svg', 'pointerleave');
  assert.equal(harness.viewport.innerHTML, baseline, 'leaving restores the original gate half without its connecting stem');
  harness.hover.move(harness.hover.target('gate', 57));
  harness.context.select({ type: 'gate', id: '57', additive: true });
  harness.hover.send('svg', 'pointerleave');
  assert.deepEqual(JSON.parse(JSON.stringify(harness.context.selectedItems)), [{ type: 'gate', id: 20 }, { type: 'gate', id: 57 }]);
  assert.equal(visibleHighlights(harness.viewport.innerHTML).integrationPaths.has(stemPath), true, 'both pinned gates keep their connecting channel after leave');
  assert.deepEqual(new Set(pressed(harness.viewport.innerHTML).filter(value => /^(?:gate|channel|integration):/.test(value))), new Set(['gate:20', 'gate:57']));
  harness.hover.move(harness.hover.target('gate', 57));
  harness.context.select({ type: 'gate', id: '57', additive: true });
  assert.equal(visibleHighlights(harness.viewport.innerHTML).integrationPaths.has(stemPath), true, 'the still-hovered removed partner remains a temporary preview');
  assert.deepEqual(pressed(harness.viewport.innerHTML), baselinePressed);
  harness.hover.send('svg', 'pointerleave');
  assert.equal(harness.viewport.innerHTML, baseline, 'removal then leave restores exactly the original gate');
  assert.equal(harness.activationPopover.currentId, null);
  assert.equal(harness.popupCalls.show, 0);
});

for (const [first, second] of [
  [{ type: 'gate', id: 20 }, { type: 'center', id: 'sacral' }],
  [{ type: 'center', id: 'sacral' }, { type: 'gate', id: 20 }],
]) {
  test(`actual ${first.type} then Shift ${second.type} connects 20–34 while preserving the complete sacral selection`, t => {
    const harness = graphHarness(t, null);
    harness.context.select(first);
    const baseline = harness.viewport.innerHTML, baselinePressed = pressed(baseline);
    harness.hover.move(harness.hover.target(second.type, second.id));
    assert.equal(visibleHighlights(harness.viewport.innerHTML).integrationPaths.has(stemPath), true, 'hovering the partner gate or center previews the complete connection');
    assert.deepEqual(pressed(harness.viewport.innerHTML), baselinePressed);
    assert.deepEqual(JSON.parse(JSON.stringify(harness.context.selectedItems)), [first]);
    harness.hover.send('svg', 'pointerleave');
    assert.equal(harness.viewport.innerHTML, baseline, 'leaving without Shift restores the original scope');
    harness.hover.move(harness.hover.target(second.type, second.id));
    harness.context.select({ ...second, additive: true });
    harness.hover.send('svg', 'pointerleave');
    assert.deepEqual(JSON.parse(JSON.stringify(harness.context.selectedItems)), [first, second]);
    const connected = visibleHighlights(harness.viewport.innerHTML);
    assert.deepEqual(connected.integrationPaths, visibleHighlights(renderBodygraph(harness.chart, { type: 'channel', id: '20-34' })).integrationPaths);
    assert.deepEqual(connected.centers, new Set(['sacral']));
    assert.deepEqual(connected.gates, new Set(['20', ...GATES.filter(gate => gate.center === 'sacral').map(gate => String(gate.id))]));
    const graphPressed = [...harness.viewport.innerHTML.matchAll(/<g data-type="([^"]+)" data-id="([^"]+)"[^>]*aria-pressed="true"[^>]*>/g)].map(([, type, id]) => `${type}:${id}`);
    assert.deepEqual(new Set(graphPressed), new Set(['gate:20', 'center:sacral']), 'the connected channel and related sacral diagram gates are not promoted into individual selections');
    harness.hover.move(harness.hover.target(second.type, second.id));
    harness.context.select({ ...second, additive: true });
    assert.deepEqual(JSON.parse(JSON.stringify(harness.context.selectedItems)), [first]);
    assert.deepEqual(pressed(harness.viewport.innerHTML), baselinePressed);
    assert.equal(visibleHighlights(harness.viewport.innerHTML).integrationPaths.has(stemPath), true, 'the removed scope remains visual only while still hovered');
    harness.hover.send('svg', 'pointerleave');
    assert.equal(harness.viewport.innerHTML, baseline, 'removing the added scope then leaving removes the inferred connection');
    harness.context.select({ ...second, additive: true });
    harness.context.select({ ...first, additive: true });
    assert.deepEqual(JSON.parse(JSON.stringify(harness.context.selectedItems)), [second], 'the other item can be removed independently as well');
    assert.equal(harness.viewport.innerHTML, renderBodygraph(harness.chart, second, { showActivations: true }));
    assert.equal(harness.activationPopover.currentId, null);
    assert.equal(harness.popupCalls.show, 0);
  });
}

test('Shift removing gate 34 from the connected sacral center breaks 20–34 and retains all other selected gates', t => {
  const harness = graphHarness(t, null);
  harness.context.select({ type: 'gate', id: 20 });
  harness.context.select({ type: 'center', id: 'sacral', additive: true });
  assert.equal(visibleHighlights(harness.viewport.innerHTML).integrationPaths.has(stemPath), true);
  harness.context.select({ type: 'gate', id: 34, additive: true });
  const remaining = [20, ...GATES.filter(gate => gate.center === 'sacral' && gate.id !== 34).map(gate => gate.id)];
  assert.deepEqual(JSON.parse(JSON.stringify(harness.context.selectedItems)), remaining.map(id => ({ type: 'gate', id })));
  const baseline = harness.viewport.innerHTML;
  assert.deepEqual(visibleHighlights(baseline).gates, new Set(remaining.map(String)));
  assert.equal(visibleHighlights(baseline).integrationPaths.has(stemPath), false);
  assert.equal(visibleHighlights(baseline).centers.has('sacral'), false);
  harness.hover.move(harness.hover.target('gate', 34));
  assert.equal(visibleHighlights(harness.viewport.innerHTML).integrationPaths.has(stemPath), true, 'hover can temporarily restore the missing integration partner');
  assert.equal(visibleHighlights(harness.viewport.innerHTML).centers.has('sacral'), true, 'hover can also temporarily complete the individual center gates');
  assert.deepEqual(pressed(harness.viewport.innerHTML), pressed(baseline));
  harness.hover.send('svg', 'pointerleave');
  assert.equal(harness.viewport.innerHTML, baseline);
  harness.context.select({ type: 'gate', id: 34, additive: true });
  assert.equal(visibleHighlights(harness.viewport.innerHTML).integrationPaths.has(stemPath), true);
  assert.equal(visibleHighlights(harness.viewport.innerHTML).centers.has('sacral'), true);
  assert.ok(harness.context.selectedItems.every(item => item.type === 'gate'), 'readding gate 34 restores a derived center outline, not an atomic center item');
  assert.equal(harness.popupCalls.show, 0);
});

test('completing a center through individual Shift clicks only derives its outline and removal or hover never promotes it', t => {
  const harness = graphHarness(t, null);
  const gates = GATES.filter(gate => gate.center === 'heart').map(gate => gate.id);
  for (const id of gates) harness.context.select({ type: 'gate', id: String(id), additive: true });
  assert.deepEqual(JSON.parse(JSON.stringify(harness.context.selectedItems)), gates.map(id => ({ type: 'gate', id })));
  assert.equal(harness.context.selection.type, 'gate', 'the primary item remains the last individual gate');
  assert.equal(visibleHighlights(harness.viewport.innerHTML).centers.has('heart'), true);
  assert.equal(pressed(harness.viewport.innerHTML).includes('center:heart'), false, 'the inferred outline is not an atomic selected center');
  const removed = gates.at(-1);
  harness.context.select({ type: 'gate', id: String(removed), additive: true });
  assert.equal(visibleHighlights(harness.viewport.innerHTML).centers.has('heart'), false);
  const remaining = JSON.stringify(harness.context.selectedItems), committedPressed = pressed(harness.viewport.innerHTML);
  harness.hover.move(harness.hover.target('gate', removed));
  assert.equal(visibleHighlights(harness.viewport.innerHTML).centers.has('heart'), true, 'hovering the last missing gate temporarily completes the outline');
  assert.equal(JSON.stringify(harness.context.selectedItems), remaining);
  assert.deepEqual(pressed(harness.viewport.innerHTML), committedPressed);
  harness.hover.send('svg', 'pointerleave');
  assert.equal(visibleHighlights(harness.viewport.innerHTML).centers.has('heart'), false);
  assert.equal(JSON.stringify(harness.context.selectedItems), remaining);
  assert.equal(harness.popupCalls.show, 0);
});

for (const center of CENTERS) {
  test(`Shift subtraction from ${center.id} removes its outline after pointer leave and readding restores only a derived outline`, t => {
    const harness = graphHarness(t, null);
    const gates = GATES.filter(gate => gate.center === center.id).map(gate => gate.id);
    for (const removed of gates) {
      harness.context.select({ type: 'center', id: center.id });
      harness.hover.move(harness.hover.target('gate', removed, 'design-mercury'));
      harness.context.select({ type: 'gate', id: String(removed), activation: 'design-mercury', additive: true });
      const expected = gates.filter(id => id !== removed).map(id => ({ type: 'gate', id }));
      assert.deepEqual(JSON.parse(JSON.stringify(harness.context.selectedItems)), expected);
      assert.equal(pressed(harness.viewport.innerHTML).includes(`center:${center.id}`), false, 'the explicit center is removed from committed state immediately');
      assert.equal(pressed(harness.viewport.innerHTML).includes(`gate:${removed}`), false, 'the clicked gate is no longer committed even while hovered');
      assert.equal(visibleHighlights(harness.viewport.innerHTML).centers.has(center.id), true, 'the still-hovered missing gate can temporarily complete the center');
      harness.hover.send('svg', 'pointerleave');
      const baseline = harness.viewport.innerHTML;
      assert.deepEqual(visibleHighlights(baseline).centers, new Set(), 'leaving reveals the partial center with no outline');
      assert.deepEqual(visibleHighlights(baseline).gates, new Set(expected.map(item => String(item.id))));
      assert.deepEqual(new Set(pressed(baseline).filter(item => /^(?:gate|center):/.test(item))), new Set(expected.map(item => `gate:${item.id}`)));
      harness.hover.move(harness.hover.target('gate', removed));
      assert.equal(visibleHighlights(harness.viewport.innerHTML).centers.has(center.id), true);
      assert.deepEqual(pressed(harness.viewport.innerHTML), pressed(baseline), 'hover completion never commits the missing gate or center');
      harness.hover.send('svg', 'pointerleave');
      assert.equal(harness.viewport.innerHTML, baseline, 'leaving again restores precisely the subtracted selection');
      harness.context.select({ type: 'gate', id: String(removed), activation: 'design-mercury', additive: true });
      assert.deepEqual(JSON.parse(JSON.stringify(harness.context.selectedItems)), [...expected, { type: 'gate', id: removed, activation: 'design-mercury' }]);
      assert.equal(visibleHighlights(harness.viewport.innerHTML).centers.has(center.id), true, 'readding the missing individual gate restores the automatic outline');
      assert.equal(pressed(harness.viewport.innerHTML).includes(`center:${center.id}`), false);
      assert.equal(harness.activationPopover.currentId, null, 'subtracting or readding within a group never opens percentages');
    }
    assert.equal(harness.popupCalls.show, 0);
  });
}

test('hover alone opens no popup; click pins, second exact click unpins, and leave restores that committed state', t => {
  const harness = graphHarness(t, null);
  const target = harness.hover.target('gate', 41, 'design-sun');
  harness.hover.move(target);
  assert.equal(harness.context.selection, null);
  assert.equal(harness.activationPopover.currentId, null);
  assert.equal(harness.popupCalls.show, 0);
  harness.context.select({ type: 'gate', id: '41', activation: 'design-sun' });
  assert.equal(harness.context.selection.id, 41);
  assert.equal(harness.activationPopover.currentId, 'design-sun');
  assert.deepEqual(harness.hover.controller.currentSelection, { type: 'gate', id: 41 }, 'clicking leaves the current hover preview intact');
  harness.context.select({ type: 'gate', id: '41', activation: 'design-sun' });
  assert.equal(harness.context.selection, null);
  assert.equal(harness.context.selectedActivation, null);
  assert.equal(harness.activationPopover.currentId, null);
  assert.equal(harness.popupCalls.show, 1);
  assert.equal(withoutPressed(harness.viewport.innerHTML), withoutPressed(renderBodygraph(harness.chart, { type: 'gate', id: 41 }, { showActivations: true })), 'the pointer still provides its temporary highlight after unpinning');
  harness.hover.send('svg', 'pointerleave');
  assert.equal(harness.viewport.innerHTML, renderBodygraph(harness.chart, null, { showActivations: true }));
  harness.hover.move(harness.hover.target('center', 'throat'));
  harness.context.select({ type: 'center', id: 'throat' });
  harness.hover.send('svg', 'pointerleave');
  assert.equal(harness.viewport.innerHTML, renderBodygraph(harness.chart, { type: 'center', id: 'throat' }, { showActivations: true }), 'leaving after pinning a center retains its full click highlight');
});
