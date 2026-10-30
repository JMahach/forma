import type { Activation } from '../shared/chart-types.ts';
import type { GraphController } from '../src/scene/updates.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createGraphController } from '../src/scene/updates.ts';
import { attachHoverPreview } from '../src/selection/hover-preview.ts';
import { renderBodygraph } from '../src/scene/bodygraph-svg.ts';
import { createSelectionModel } from '../src/selection/selection-model.ts';
import { CENTERS, GATES } from '../src/scene/geometry/chart-geometry.ts';
import { STEM_POINTS } from '../src/scene/geometry/integration-geometry.ts';
import type { ChartView, ChartInput } from '../src/domain/chart-composition.ts';
import type { SelectionTarget, PreviewSelection } from '../src/selection/selection-targets.ts';

interface HoverNode {
  dataset: Record<string, string>; insideSvg: boolean; parent: HoverNode | null;
  closest(selector: string): HoverNode | null;
}
interface HoverEvent {
  target: unknown; relatedTarget: unknown; pointerType: string; pointerId: number; buttons: number; button: number;
  defaultPrevented: boolean; propagationStopped: boolean;
  preventDefault(): void; stopPropagation(): void; [key: string]: unknown;
}
type PreviewHandler = (selection: PreviewSelection | null) => void;
type HoverChart = ChartInput & { personality: number[]; design: number[]; activations: { design: Activation[]; personality: Activation[] } };
type SelectionState = ReturnType<typeof createSelectionModel>;
interface GraphContext {
  selectionState: SelectionState; selection: SelectionState['primary']; selectedActivation: string | null;
  selectedItems: SelectionState['items']; savedCharts: (ChartInput & { id: string })[]; selectedChartId: string;
  liveWanted: boolean; chart(): ChartInput & { id: string }; render: GraphController['render']; select: GraphController['choose'];
  clear: GraphController['clear']; change: GraphController['changeChart'];
}
function hoverHarness(t: test.TestContext, options:Partial<Parameters<typeof attachHoverPreview>[1]>={}) {
  const originals = new Map(['document', 'window'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  t.after(() => {
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete (globalThis as unknown as Record<string, unknown>)[key];
    }
  });
  const listeners = new Map<string, ((event: HoverEvent) => void)[]>(), previews: (PreviewSelection | null)[] = [], classes = new Set<string>();
  let previewHandler: PreviewHandler | undefined;
  const addListener = (surface: string) => (type: string, callback: (event: HoverEvent) => void, options?:AddEventListenerOptions) => {
    if(options?.signal?.aborted)return;
    const key = `${surface}:${type}`;
    if (!listeners.has(key)) listeners.set(key, []);
    listeners.get(key)!.push(callback);
    options?.signal?.addEventListener('abort',()=>listeners.set(key,(listeners.get(key)??[]).filter(fn=>fn!==callback)),{once:true});
  };
  let hit: HoverNode | null = null;
  const document = { elementFromPoint: () => hit, hidden: false, visibilityState: 'visible', addEventListener: addListener('document') };
  const window = { addEventListener: addListener('window') };
  Object.defineProperty(globalThis, 'document', { configurable: true, writable: true, value: document });
  Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: window });
  const svg = {
    addEventListener: addListener('svg'),
    classList: { contains: (name: string) => classes.has(name) },
    contains(target: { insideSvg: boolean; }) { return target?.insideSvg === true; },
  };
  function node(dataset: Record<string, string> = {}, { insideSvg = true, parent = null }: { insideSvg?: boolean; parent?: HoverNode | null } = {}): HoverNode {
    return {
      dataset, insideSvg, parent,
      closest(selector: string) {
        let matches = true;
        for (const [, rawKey, expected] of selector.matchAll(/\[data-([a-z-]+)(?:=["']([^"']+)["'])?\]/g)) {
          const key = rawKey.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
          if (!Object.hasOwn(dataset, key) || expected !== undefined && dataset[key] !== expected) matches = false;
        }
        return matches ? this : this.parent?.closest(selector) || null;
      },
    };
  }
  const target = (type: string, id: string | number, activation?: string) => node({ type, id: String(id), ...(activation ? { activation } : {}) });
  function send(surface: string, type: string, options: Partial<HoverEvent> = {}) {
    const event: HoverEvent = {
      target: svg, clientX: 320, clientY: 436, relatedTarget: null, pointerType: 'mouse', pointerId: 1, buttons: 0, button: 0,
      defaultPrevented: false, propagationStopped: false,
      preventDefault() { this.defaultPrevented = true; },
      stopPropagation() { this.propagationStopped = true; },
      ...options,
    };
    for (const callback of listeners.get(`${surface}:${type}`) || []) callback(event);
    return event;
  }
  const controller = attachHoverPreview(svg as unknown as SVGSVGElement, { ...options,onPreview(selection) { previews.push(selection); previewHandler?.(selection); } });
  const move = (target: unknown, options: Partial<HoverEvent> = {}) => {
    hit = target as HoverNode;
    return send('svg', 'pointermove', { target, ...options });
  };
  return { controller, svg, document, previews, classes, listeners, node, target, send, move, setHit(value: HoverNode | null) { hit = value; }, setPreviewHandler(handler: PreviewHandler) { previewHandler = handler; } };
}

test('pointer movement previews numeric activations, diagram gates, centers, channels and integration', t => {
  const harness = hoverHarness(t);
  assert.equal(harness.controller.currentSelection, null);
  for (const [type, id, activation] of [
    ['gate', 41, 'personality-mercury'], ['gate', 19, 'design-sun'], ['gate', 37],
    ['center', 'throat'], ['channel', '37-40'], ['integration', 'integration'],
  ] as const) {
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
  ] as const) harness.move(target);
  assert.deepEqual(harness.previews, [{ type: 'gate' as const, id: 41 }]);
  assert.deepEqual(harness.controller.currentSelection, { type: 'gate' as const, id: 41 });
});

test('planet hover preserves ordinary and overlay identities without repeating the same preview', t => {
  const harness = hoverHarness(t);
  const expected = [];
  for (const id of ['design-sun', 'personality-sun', 'natal-sun', 'cycle-sun'] as const) {
    const target = harness.target('planet', id, `${id}-planet`);
    const selection = { type: 'planet' as const, id };
    harness.move(target);
    expected.push(selection);
    assert.deepEqual(harness.controller.currentSelection, selection);
    harness.move(harness.node({}, { parent: target }));
    harness.move(harness.target('planet', id, `${id}-planet`));
    assert.deepEqual(harness.previews, expected, 'descendants and replacement glyphs keep one preview per planet');
  }
  harness.send('svg', 'pointerleave');
  harness.send('svg', 'pointerleave');
  assert.equal(harness.controller.currentSelection, null);
  assert.deepEqual(harness.previews, [...expected, null], 'leaving clears the last planet once');
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
  assert.deepEqual(harness.previews, [{ type: 'center' as const, id: 'throat' }], 'equivalent nodes created by redraw keep a single preview');
});

test('touch, pressed pointers, filter controls and malformed gates do not preview', t => {
  const harness = hoverHarness(t), number = harness.target('gate', 41, 'personality-mercury');
  for (const options of [{ pointerType: 'touch' }, { buttons: 1 }, { buttons: 2 }] as const) {
    harness.move(number, options);
    harness.move(harness.target('planet', 'design-sun', 'design-sun-planet'), options);
  }
  for (const target of [
    harness.target('planet-filter', 'design:sun'),
    harness.target('gate', 0), harness.target('gate', 65), harness.target('gate', 1.5), harness.target('gate', 'invalid'),
    harness.target('unknown', 'anything'), harness.node({}),
  ] as const) harness.move(target);
  assert.equal(harness.controller.currentSelection, null);
  assert.deepEqual(harness.previews, []);
});

test('raw pointer events preserve preview until the graph controller commits selection', t => {
  const harness = hoverHarness(t), target = harness.target('center', 'throat');
  harness.move(target);
  for (const type of ['pointerdown', 'pointerup', 'click'] as const) {
    const event = harness.send('svg', type, { target, buttons: type === 'pointerdown' ? 1 : 0 });
    assert.deepEqual(harness.controller.currentSelection, { type: 'center' as const, id: 'throat' });
    assert.equal(event.defaultPrevented, false);
    assert.equal(event.propagationStopped, false);
  }
  assert.deepEqual(harness.previews, [{ type: 'center' as const, id: 'throat' }]);
  harness.send('svg', 'pointerleave');
  assert.deepEqual(harness.previews, [{ type: 'center' as const, id: 'throat' }, null]);
});

test('moving with a pressed pointer or while dragging clears the preview and blocks its return during the drag', t => {
  const harness = hoverHarness(t), target = harness.target('gate', 41, 'personality-mercury');
  harness.move(target);
  harness.move(target, { buttons: 1 });
  assert.equal(harness.controller.currentSelection, null);
  harness.classes.add('is-dragging');
  harness.move(target);
  assert.deepEqual(harness.previews, [{ type: 'gate' as const, id: 41 }, null]);
  harness.classes.delete('is-dragging');
  harness.move(target);
  assert.deepEqual(harness.controller.currentSelection, { type: 'gate' as const, id: 41 });
});

test('background movement, leave, blur and hidden-document events restore the committed display once', t => {
  const harness = hoverHarness(t), target = harness.target('center', 'solar');
  for (const dismiss of [
    () => harness.move(harness.node({})),
    () => harness.send('svg', 'pointerleave'),
    () => harness.send('window', 'blur'),
    () => { harness.document.hidden = true; harness.document.visibilityState = 'hidden'; harness.send('document', 'visibilitychange'); },
  ] as const) {
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
  assert.deepEqual(harness.previews, [{ type: 'gate' as const, id: 41 }]);
  harness.controller.clear();
  assert.deepEqual(harness.previews, [{ type: 'gate' as const, id: 41 }], 'clearing an empty preview is harmless');
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
} as unknown as HoverChart);

// Geometry and source paint stay identical; committed feedback alone is darker.
const withoutPressed = (markup: string) => markup
  // Dormant two-color sources prepare native focus of a pinned half; visible geometry stays unchanged.
  .replace(/<g class="bg-channel-color-defs">[\s\S]*?<\/g>/g, '')
  .replace(/url\(#[^)]*-channel-colors-[^)]+\)/g, '#91bce9')
  .replace(/ aria-pressed="(?:true|false)"/g, '')
  .replace(/<g class="bg-integration-color-defs">[\s\S]*?<\/g>(?=\n    <linearGradient)/g, '')
  .replace(/url\(#[^)]*-integration-highlight-colors\)/g, '#91bce9')
  .replaceAll('#83a9d2', '#91bce9');
const pressed = (markup: string) => [...markup.matchAll(/<g\b[^>]*data-type="([^"]+)"[^>]*data-id="([^"]+)"[^>]*aria-pressed="true"[^>]*>/g)]
  .map(([, type, id]) => `${type}:${id}`).sort();

test('unpinned gate hover uses the click geometry for every gate, including its own channel halves and integration', () => {
  const chart = chartFixture(), pinned = null;
  const before = JSON.stringify({ chart, pinned });
  for (const gate of GATES) {
    const preview = { type: 'gate' as const, id: gate.id };
    const hovered = renderBodygraph(chart, pinned, { showActivations: true, previewSelection: preview });
    const clicked = renderBodygraph(chart, preview, { showActivations: true });
    assert.equal(withoutPressed(hovered), withoutPressed(clicked), `gate ${gate.id} keeps exactly its click appearance`);
    assert.deepEqual(pressed(hovered), pressed(renderBodygraph(chart, pinned, { showActivations: true })), 'hover does not change the committed accessible selection');
  }
  assert.equal(JSON.stringify({ chart, pinned }), before);
});

test('unpinned center, channel and integration hover geometry matches click geometry without creating a committed selection', () => {
  const chart = chartFixture(), pinned = null;
  for (const preview of [
    ...CENTERS.map(center => ({ type: 'center' as const, id: center.id })),
    { type: 'channel' as const, id: '37-40' }, { type: 'channel' as const, id: '10-20' }, { type: 'integration' as const, id: 'integration' },
  ] as const) {
    const hovered = renderBodygraph(chart, pinned, { showActivations: true, previewSelection: preview });
    const clicked = renderBodygraph(chart, preview, { showActivations: true });
    assert.equal(withoutPressed(hovered), withoutPressed(clicked), `${preview.type} ${preview.id} matches its click appearance`);
    assert.deepEqual(pressed(hovered), pressed(renderBodygraph(chart, pinned, { showActivations: true })));
  }
});

test('hover highlights every numeric copy of a gate across both columns without changing their pressed state', () => {
  const chart = chartFixture();
  const markup = renderBodygraph(chart, null, { showActivations: true, previewSelection: { type: 'gate' as const, id: 41 } });
  const rows = [...markup.matchAll(/<g class="bg-activation"[^>]*data-id="([^"]+)"[^>]*data-activation="([^"]+)"[^>]*>([\s\S]*?)<\/g>/g)];
  assert.equal(rows.length, chart.activations.personality.length + chart.activations.design.length);
  for (const [whole, gate, id, content] of rows) {
    assert.match(content, new RegExp(`fill="${gate === '41' ? '#91bce9' : 'transparent'}"`), `${id} follows the hovered gate number`);
    assert.match(whole, /aria-pressed="false"/, `${id} remains unpinned`);
  }
  assert.deepEqual(pressed(markup), []);
});

test('ending a preview restores the committed paint, including an empty selection', () => {
  const chart = chartFixture();
  for (const pinned of [null, { type: 'gate' as const, id: 37 }, { type: 'center' as const, id: 'throat' }, { type: 'channel' as const, id: '37-40' }] as const) {
    const baseline = renderBodygraph(chart, pinned, { showActivations: true });
    const hovered = renderBodygraph(chart, pinned, { showActivations: true, previewSelection: { type: 'gate' as const, id: 41 } });
    assert.notEqual(hovered, baseline);
    assert.equal(renderBodygraph(chart, pinned, { showActivations: true, previewSelection: null }), baseline);
  }
});

function visibleHighlights(markup: string) {
  const starts = [...markup.matchAll(/<g data-type="([^"]+)" data-id="([^"]+)"[^>]*>/g)];
  const groups = starts.map((match, index) => ({ type: match[1], id: match[2], attributes: match[0], content: markup.slice(match.index, starts[index + 1]?.index ?? markup.length) }));
  const integrationPath = markup.match(/<path class="bg-integration-selection" d="([^"]+)"/)?.[1] || '';
  return {
    gates: new Set(groups.filter(group => group.type === 'gate' && /data-related="true"/.test(group.attributes)).map(group => group.id)),
    centers: new Set(groups.filter(group => group.type === 'center' && /<path class="bg-center-highlight"[^>]*opacity="1"/.test(group.content)).map(group => group.id)),
    channels: new Set(groups.filter(group => group.type === 'channel' && /<path class="bg-channel-highlight"[^>]*opacity="1"/.test(group.content)).map(group => group.id)),
    relatedChannels: new Set(groups.filter(group => group.type === 'channel' && /data-related="true"/.test(group.attributes)).map(group => group.id)),
    halfPaths: new Set(groups.filter(group => group.type === 'channel').flatMap(group => [...group.content.matchAll(/<g data-highlight-gate="(\d+)">(<path[^>]*\/>)/g)].map(([, gate, path]) => `${group.id}:${gate}:${path}`))),
    integrationPaths: new Set(integrationPath.split(/(?=M)/).map((path: string) => path.trim()).filter(Boolean)),
    numericCopies: new Set([...markup.matchAll(/<g class="bg-activation"[^>]*data-activation="([^"]+)"[^>]*data-selected="true"/g)].map(([, id]) => id)),
  };
}

function assertVisualUnion(chart: ChartView, pinned: SelectionTarget | null, preview: SelectionTarget | null) {
  const options = { showActivations: true };
  const pinnedMarkup = renderBodygraph(chart, pinned, options), previewMarkup = renderBodygraph(chart, preview, options);
  const markup = renderBodygraph(chart, pinned, { ...options, previewSelection: preview });
  const actual = visibleHighlights(markup), base = visibleHighlights(pinnedMarkup), extra = visibleHighlights(previewMarkup);
  const fullChannels = new Set([...base.channels, ...extra.channels]);
  const ownedGates = new Set([pinned, preview].flatMap(value => value?.type === 'gate' ? [Number(value.id)]
    : value?.type === 'center' ? GATES.filter(gate => gate.center === value.id).map(gate => gate.id) : []));
  const connectsIntegrationStem = [10, 20].some(id => ownedGates.has(id)) && [34, 57].some(id => ownedGates.has(id));
  for (const key of Object.keys(actual) as (keyof typeof actual)[]) {
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
  const chart = chartFixture(), pinned = Object.freeze({ type: 'center' as const, id: 'throat' });
  const snapshot = JSON.stringify({ chart, pinned });
  for (const id of [1, 20, 29] as const) {
    const markup = assertVisualUnion(chart, pinned, { type: 'gate' as const, id });
    assert.deepEqual(visibleHighlights(markup).centers, new Set(['throat']));
    assert.deepEqual(visibleHighlights(markup).gates, new Set([...GATES.filter(gate => gate.center === 'throat').map(gate => String(gate.id)), String(id)]));
  }
  assert.equal(JSON.stringify({ chart, pinned }), snapshot, 'hover does not modify chart or pinned selection data');
});

test('center-plus-center and channel-plus-gate previews preserve both independent highlight scopes', () => {
  const chart = chartFixture();
  for (const [pinned, preview] of [
    [{ type: 'center' as const, id: 'throat' }, { type: 'center' as const, id: 'sacral' }],
    [{ type: 'center' as const, id: 'throat' }, { type: 'center' as const, id: 'throat' }],
    [{ type: 'gate' as const, id: 29 }, { type: 'center' as const, id: 'throat' }],
    [{ type: 'channel' as const, id: '37-40' }, { type: 'gate' as const, id: 29 }],
    [{ type: 'channel' as const, id: '37-40' }, { type: 'gate' as const, id: 37 }],
    [{ type: 'gate' as const, id: 29 }, { type: 'channel' as const, id: '37-40' }],
    [{ type: 'gate' as const, id: 29 }, { type: 'gate' as const, id: 29 }],
  ] as const) assertVisualUnion(chart, pinned, preview);
});

test('additive column highlights keep all repeated throat gate 20 copies and add every hovered gate 29 copy', () => {
  const chart = chartFixture(), pinned = { type: 'center' as const, id: 'throat' };
  const markup = assertVisualUnion(chart, pinned, { type: 'gate' as const, id: 29 });
  const rows = [...markup.matchAll(/<g class="bg-activation"[^>]*data-id="([^"]+)"[^>]*data-activation="([^"]+)"[^>]*>([\s\S]*?)<\/g>/g)];
  const throatGates = new Set(GATES.filter(gate => gate.center === 'throat').map(gate => gate.id));
  for (const [whole, gate, id, content] of rows) {
    const pinnedCopy = throatGates.has(Number(gate)), lit = pinnedCopy || gate === '29';
    assert.match(content, new RegExp(`fill="${lit ? '#91bce9' : 'transparent'}"`), `${id} uses additive numeric highlighting`);
    assert.match(whole, new RegExp(`aria-pressed="${pinnedCopy}"`), `${id} distinguishes the committed gate from the hovered gate`);
  }
  assert.equal(rows.filter(([, gate]) => gate === '20').length, 4, 'gate 20 repeats in both sources');
  assert.equal(rows.filter(([, gate]) => gate === '29').length, 2, 'hovered gate 29 is present in both sources');
});

test('channel-endpoint previews do not infer another integration connection with a gate or center', () => {
  const chart = chartFixture();
  for (const [pinned, preview] of [
    [{ type: 'channel' as const, id: '10-20' }, { type: 'gate' as const, id: 57 }],
    [{ type: 'channel' as const, id: '10-20' }, { type: 'center' as const, id: 'spleen' }],
    [{ type: 'center' as const, id: 'throat' }, { type: 'channel' as const, id: '34-57' }],
    [{ type: 'gate' as const, id: 20 }, { type: 'channel' as const, id: '34-57' }],
  ] as const) {
    const markup = assertVisualUnion(chart, pinned, preview);
    const mask = markup.match(/<mask id="bodygraph-integration-selection-outline"[^>]*>([\s\S]*?)<\/mask>/)?.[1];
    assert.ok(mask, 'partial integration highlights retain their ownership mask');
    assert.doesNotMatch(mask!, /class="bg-integration-owned-stem"/, 'related endpoints do not infer a selected gate pair');
    assert.equal(visibleHighlights(markup).integrationPaths.has(stemPath), false);
    assert.match(markup, /data-junction="integration" data-visual-selected="false"/, 'independent arms do not become a whole-integration selection');
  }
});

const stemPath = STEM_POINTS.map(([x, y], index) => `${index ? 'L' : 'M'}${x.toFixed(2)},${y.toFixed(2)}`).join(' ');

test('hovering an individual integration partner previews the exact connecting channel without pressing it', () => {
  const chart = chartFixture();
  for (const [first, second] of [[20, 57], [57, 20], [10, 34], [34, 10]] as const) {
    const pinned = { type: 'gate' as const, id: first }, preview = { type: 'gate' as const, id: second };
    const markup = assertVisualUnion(chart, pinned, preview);
    const explicit = renderBodygraph(chart, { type: 'channel' as const, id: [first, second].sort((a, b) => a - b).join('-') }, { showActivations: true });
    assert.deepEqual(visibleHighlights(markup).integrationPaths, visibleHighlights(explicit).integrationPaths);
    assert.equal(visibleHighlights(markup).integrationPaths.has(stemPath), true);
    assert.deepEqual(pressed(markup), pressed(renderBodygraph(chart, pinned, { showActivations: true })));
    assert.match(markup, /data-junction="integration" data-visual-selected="false"/);
  }
});

test('an explicit cross-node channel or whole integration contributes its stem exactly once to an additive preview', () => {
  const chart = chartFixture();
  for (const [pinned, preview] of [
    [{ type: 'channel' as const, id: '20-57' }, { type: 'gate' as const, id: 10 }],
    [{ type: 'gate' as const, id: 57 }, { type: 'channel' as const, id: '20-34' }],
    [{ type: 'channel' as const, id: '20-57' }, { type: 'channel' as const, id: '10-34' }],
    [{ type: 'integration' as const, id: 'integration' }, { type: 'gate' as const, id: 29 }],
    [{ type: 'center' as const, id: 'throat' }, { type: 'integration' as const, id: 'integration' }],
  ] as const) {
    const markup = assertVisualUnion(chart, pinned, preview);
    const integrationPath = markup.match(/<path class="bg-integration-selection" d="([^"]+)"/)?.[1];
    assert.ok(integrationPath);
    const paths = integrationPath!.split(/(?=M)/).map(path => path.trim()).filter(Boolean);
    assert.equal(paths.length, new Set(paths).size, 'shared arms and the stem are not duplicated');
    assert.equal(paths.filter(path => path === stemPath).length, 1, 'the explicit crossing channel contributes the common stem exactly once');
    const whole = pinned.type === 'integration' || preview.type === 'integration';
    if (!whole) {
      const mask = markup.match(/<mask id="bodygraph-integration-selection-outline"[^>]*>([\s\S]*?)<\/mask>/)?.[1];
      const wholeExterior = /<rect[^>]*fill="#ffffff"/.test(mask!);
      assert.ok(wholeExterior || /class="bg-integration-owned-stem"/.test(mask!), 'the ownership mask permits the explicit stem, including a complete union of both crossing channels');
    }
  }
});

function graphHarness(t: test.TestContext, selection: SelectionTarget | null, selectedActivation: string | null = null) {
  const hover = hoverHarness(t), chart = { ...chartFixture(), id: 'hover-chart' };
  const viewport = { innerHTML: '', querySelector() { return null; } };
  const popupCalls = { show: 0, close: 0, refresh: 0 };
  const activationPopover = {
    currentId: selectedActivation,
    show(_chart: ChartView, id: string) { this.currentId = id; popupCalls.show++; },
    close() { this.currentId = null; popupCalls.close++; },
    refresh() { popupCalls.refresh++; },
  };
  const selectionState = createSelectionModel();
  if (selection) selectionState.choose({ ...selection, ...(selectedActivation ? { activation: selectedActivation } : {}) });
  const nextChart = { id: 'next-chart', source: 'manual' as const, personality: [1], design: [8] };
  const context = {
    selectionState,
    get selection() { return selectionState.primary; },
    get selectedActivation() { return selectionState.activation; },
    get selectedItems() { return selectionState.items; },
    savedCharts: [chart, nextChart], selectedChartId: chart.id, liveWanted: false,
    chart: () => context.savedCharts.find(item => item.id === context.selectedChartId)!,
  } as unknown as GraphContext;
  const controller = createGraphController({
    selectionState: selectionState as unknown as NonNullable<Parameters<typeof createGraphController>[0]['selectionState']>, getChart: context.chart, viewport: viewport as unknown as Element, activationPopover,
    hasChart: () => context.savedCharts.some(item => item.id === context.selectedChartId),
    getHoverPreview: () => hover.controller,
    scene: { update(chart, selection, options) { viewport.innerHTML = renderBodygraph(chart, selection, options); }, clear() { viewport.innerHTML = ''; } },
    onChartChange(id) {
      context.selectedChartId = id;
      context.liveWanted = id === 'current-transit';
      controller.render();
    },
  });
  Object.assign(context, { render: controller.render, select: controller.choose, clear: controller.clear, change: controller.changeChart });
  hover.setPreviewHandler(() => context.render());
  context.render();
  return { hover, chart, nextChart, viewport, popupCalls, activationPopover, context };
}

const plainSelection = (harness: ReturnType<typeof graphHarness>): SelectionTarget[] => JSON.parse(JSON.stringify(harness.context.selectedItems));
for (const pointerType of ['mouse', 'touch', null] as const) {
  test(`${pointerType || 'keyboard'} three-activation selection clears stale hover so the last activation visibly removes every highlight`, t => {
    const harness = graphHarness(t, null);
    const target = harness.hover.target('gate', 41, 'design-sun');
    const value = { type: 'gate' as const, id: '41', activation: 'design-sun', ...(pointerType ? { pointerType } : {}) };
    harness.hover.move(target);
    harness.context.select(value);
    assert.equal(harness.hover.controller.currentSelection, null);
    assert.equal(harness.activationPopover.currentId, null);
    assert.equal(visibleHighlights(harness.viewport.innerHTML).gates.has('41'), true);
    harness.context.select(value);
    assert.equal(harness.activationPopover.currentId, 'design-sun');
    harness.hover.move(target);
    harness.context.select(value);
    assert.deepEqual(plainSelection(harness), []);
    assert.equal(harness.activationPopover.currentId, null);
    assert.equal(harness.hover.controller.currentSelection, null);
    assert.equal(visibleHighlights(harness.viewport.innerHTML).gates.size, 0);
    assert.equal(visibleHighlights(harness.viewport.innerHTML).numericCopies.size, 0);
    assert.equal(harness.popupCalls.show, 1, 'only the second exact activation opens details');
    const cleared = harness.viewport.innerHTML;
    harness.hover.send('svg', 'pointerleave');
    assert.equal(harness.viewport.innerHTML, cleared, 'clearing is visible before the pointer leaves');
  });
}
test('actual background clear resets committed gates and hover together', t => {
  const harness = graphHarness(t, null);
  harness.context.select({ type: 'gate', id: 41 });
  harness.hover.move(harness.hover.target('gate', 29));
  harness.context.clear();
  assert.deepEqual(plainSelection(harness), []);
  assert.equal(harness.hover.controller.currentSelection, null);
  assert.equal(harness.activationPopover.currentId, null);
  assert.equal(harness.viewport.innerHTML, renderBodygraph(harness.chart, null, { profile: 'studio', showActivations: true, showBackdrop: true }));
});

test('actual chart change clears committed selection before rendering the new chart', t => {
  const harness = graphHarness(t, null);
  harness.context.select({ type: 'gate', id: 41 });
  harness.hover.move(harness.hover.target('gate', 29));
  harness.context.change(harness.nextChart.id);
  assert.equal(harness.context.selectedChartId, harness.nextChart.id);
  assert.deepEqual(plainSelection(harness), []);
  assert.equal(harness.hover.controller.currentSelection, null);
  assert.equal(harness.activationPopover.currentId, null);
  assert.equal(harness.viewport.innerHTML, renderBodygraph(harness.nextChart, null, { profile: 'studio', showActivations: true, showBackdrop: true }));
});

test('actual hover redraws preserve the pinned selection and popup state, then restore pinned paint on leave', t => {
  const harness = graphHarness(t, Object.freeze({ type: 'gate' as const, id: 37 }), 'personality-mars');
  const pinned = Object.freeze(harness.context.selection);
  const baseline = harness.viewport.innerHTML;
  for (const [type, id, activation] of [['gate', 41, 'design-sun'], ['center', 'throat'], ['channel', '37-40'], ['integration', 'integration']] as const) {
    harness.hover.move(harness.hover.target(type, id, activation));
    assert.equal(harness.context.selection, pinned);
    assert.equal(harness.context.selectedActivation, 'personality-mars');
    assert.equal(harness.activationPopover.currentId, 'personality-mars', 'hover never replaces an open activation popup');
    assert.equal(harness.popupCalls.show, 0);
    assert.equal(harness.popupCalls.close, 0);
    assert.equal(harness.viewport.innerHTML, renderBodygraph(harness.chart, pinned, { profile: 'studio', showActivations: true, showBackdrop: true, previewSelection: { type, id } }));
  }
  harness.hover.send('svg', 'pointerleave');
  assert.equal(harness.viewport.innerHTML, baseline);
  assert.equal(harness.context.selection, pinned);
});

test('clicking an additive gate or center preview replaces the pinned selection and leaving keeps only the new selection', t => {
  const harness = graphHarness(t, Object.freeze({ type: 'center' as const, id: 'throat' }));
  const pinned = Object.freeze(harness.context.selection);
  const baseline = harness.viewport.innerHTML;
  for (const id of [1, 20, 29] as const) {
    harness.hover.move(harness.hover.target('gate', id, id === 29 ? 'design-mars' : undefined));
    assert.deepEqual(visibleHighlights(harness.viewport.innerHTML).centers, new Set(['throat']), 'the pinned center remains visible before clicking');
    assert.equal(harness.context.selection, pinned);
    assert.equal(harness.popupCalls.show, 0, 'additive hover alone opens no popup');
    harness.hover.send('svg', 'pointerleave');
    assert.equal(harness.viewport.innerHTML, baseline, 'leaving before clicking restores the original pinned center');
  }
  harness.hover.move(harness.hover.target('gate', 29, 'design-mars'));
  harness.context.select({ type: 'gate' as const, id: '29', activation: 'design-mars' });
  assert.deepEqual(JSON.parse(JSON.stringify(harness.context.selection)), { type: 'gate' as const, id: 29 });
  assert.equal(harness.context.selectedActivation, 'design-mars');
  assert.equal(harness.activationPopover.currentId, null, 'the first click selects the numeric row without details');
  assert.equal(harness.hover.controller.currentSelection, null, 'committed selection clears the previous additive hover');
  assert.deepEqual(visibleHighlights(harness.viewport.innerHTML).centers, new Set(), 'clicking replaces the old center rather than accumulating selections');
  harness.hover.send('svg', 'pointerleave');
  assert.equal(harness.viewport.innerHTML, renderBodygraph(harness.chart, { type: 'gate' as const, id: 29 }, { profile: 'studio', showActivations: true, showBackdrop: true }));
  harness.hover.move(harness.hover.target('center', 'throat'));
  assert.equal(visibleHighlights(harness.viewport.innerHTML).gates.has('29'), true, 'a later center hover adds to the newly pinned gate');
  harness.context.select({ type: 'center' as const, id: 'throat' });
  harness.hover.send('svg', 'pointerleave');
  assert.equal(harness.viewport.innerHTML, renderBodygraph(harness.chart, pinned, { profile: 'studio', showActivations: true, showBackdrop: true }), 'clicking the center replaces the gate and leaving retains only that center');
  assert.equal(harness.activationPopover.currentId, null);
});

test('hover adds to every item in a multi-selection without reopening a popup or changing committed items', t => {
  const harness = graphHarness(t, null);
  harness.context.select({ type: 'gate' as const, id: '20', activation: 'personality-earth' });
  harness.context.select({ type: 'gate' as const, id: '20', activation: 'personality-earth' });
  assert.equal(harness.activationPopover.currentId, 'personality-earth');
  harness.context.select({ type: 'gate' as const, id: '29', activation: 'design-mars', additive: true });
  const committed = JSON.stringify(harness.context.selectedItems), baseline = harness.viewport.innerHTML;
  assert.equal(harness.activationPopover.currentId, null);
  assert.equal(harness.popupCalls.show, 1, 'only the repeated single numeric selection opened a popup');
  for (const preview of [{ type: 'center' as const, id: 'throat' }, { type: 'gate' as const, id: 54 }] as const) {
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
  const harness = graphHarness(t, { type: 'gate' as const, id: 20 });
  const baseline = harness.viewport.innerHTML, baselinePressed = pressed(baseline);
  assert.equal(visibleHighlights(baseline).integrationPaths.has(stemPath), false);
  harness.hover.move(harness.hover.target('gate', 57));
  assert.equal(visibleHighlights(harness.viewport.innerHTML).integrationPaths.has(stemPath), true);
  assert.deepEqual(pressed(harness.viewport.innerHTML), baselinePressed);
  assert.deepEqual(JSON.parse(JSON.stringify(harness.context.selectedItems)), [{ type: 'gate' as const, id: 20 }]);
  assert.equal(harness.popupCalls.show, 0);
  harness.hover.send('svg', 'pointerleave');
  assert.equal(harness.viewport.innerHTML, baseline, 'leaving restores the original gate half without its connecting stem');
  harness.hover.move(harness.hover.target('gate', 57));
  harness.context.select({ type: 'gate' as const, id: '57', additive: true });
  harness.hover.send('svg', 'pointerleave');
  assert.deepEqual(JSON.parse(JSON.stringify(harness.context.selectedItems)), [{ type: 'gate' as const, id: 20 }, { type: 'gate' as const, id: 57 }]);
  assert.equal(visibleHighlights(harness.viewport.innerHTML).integrationPaths.has(stemPath), true, 'both pinned gates keep their connecting channel after leave');
  assert.deepEqual(new Set(pressed(harness.viewport.innerHTML).filter(value => /^(?:gate|channel|integration):/.test(value))), new Set(['gate:20', 'gate:57']));
  harness.hover.move(harness.hover.target('gate', 57));
  harness.context.select({ type: 'gate' as const, id: '57', additive: true });
  assert.equal(harness.hover.controller.currentSelection, null, 'Shift removal clears stale hover immediately');
  assert.equal(visibleHighlights(harness.viewport.innerHTML).integrationPaths.has(stemPath), false, 'removing a partner immediately removes the inferred connection');
  assert.deepEqual(pressed(harness.viewport.innerHTML), baselinePressed);
  harness.hover.send('svg', 'pointerleave');
  assert.equal(harness.viewport.innerHTML, baseline, 'removal then leave restores exactly the original gate');
  assert.equal(harness.activationPopover.currentId, null);
  assert.equal(harness.popupCalls.show, 0);
});

for (const [first, second] of [
  [{ type: 'gate' as const, id: 20 }, { type: 'center' as const, id: 'sacral' }],
  [{ type: 'center' as const, id: 'sacral' }, { type: 'gate' as const, id: 20 }],
] as const) {
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
    assert.deepEqual(connected.integrationPaths, visibleHighlights(renderBodygraph(harness.chart, { type: 'channel' as const, id: '20-34' })).integrationPaths);
    assert.deepEqual(connected.centers, new Set(['sacral']));
    assert.deepEqual(connected.gates, new Set(['20', ...GATES.filter(gate => gate.center === 'sacral').map(gate => String(gate.id))]));
    const graphPressed = [...harness.viewport.innerHTML.matchAll(/<g data-type="([^"]+)" data-id="([^"]+)"[^>]*aria-pressed="true"[^>]*>/g)].map(([, type, id]) => `${type}:${id}`);
    assert.deepEqual(new Set(graphPressed), new Set(['gate:20', 'center:sacral']), 'the connected channel and related sacral diagram gates are not promoted into individual selections');
    harness.hover.move(harness.hover.target(second.type, second.id));
    harness.context.select({ ...second, additive: true });
    assert.deepEqual(JSON.parse(JSON.stringify(harness.context.selectedItems)), [first]);
    assert.deepEqual(pressed(harness.viewport.innerHTML), baselinePressed);
    assert.equal(harness.hover.controller.currentSelection, null);
    assert.equal(visibleHighlights(harness.viewport.innerHTML).integrationPaths.has(stemPath), false, 'the removed scope disappears without waiting for pointer leave');
    harness.hover.send('svg', 'pointerleave');
    assert.equal(harness.viewport.innerHTML, baseline, 'removing the added scope then leaving removes the inferred connection');
    harness.context.select({ ...second, additive: true });
    harness.context.select({ ...first, additive: true });
    assert.deepEqual(JSON.parse(JSON.stringify(harness.context.selectedItems)), [second], 'the other item can be removed independently as well');
    assert.equal(harness.viewport.innerHTML, renderBodygraph(harness.chart, second, { profile: 'studio', showActivations: true, showBackdrop: true }));
    assert.equal(harness.activationPopover.currentId, null);
    assert.equal(harness.popupCalls.show, 0);
  });
}

test('Shift removing gate 34 from the connected sacral center breaks 20–34 and retains all other selected gates', t => {
  const harness = graphHarness(t, null);
  harness.context.select({ type: 'gate' as const, id: 20 });
  harness.context.select({ type: 'center' as const, id: 'sacral', additive: true });
  assert.equal(visibleHighlights(harness.viewport.innerHTML).integrationPaths.has(stemPath), true);
  harness.context.select({ type: 'gate' as const, id: 34, additive: true });
  const remaining = [20, ...GATES.filter(gate => gate.center === 'sacral' && gate.id !== 34).map(gate => gate.id)];
  assert.deepEqual(JSON.parse(JSON.stringify(harness.context.selectedItems)), remaining.map(id => ({ type: 'gate' as const, id })));
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
  harness.context.select({ type: 'gate' as const, id: 34, additive: true });
  assert.equal(visibleHighlights(harness.viewport.innerHTML).integrationPaths.has(stemPath), true);
  assert.equal(visibleHighlights(harness.viewport.innerHTML).centers.has('sacral'), true);
  assert.ok(harness.context.selectedItems.every(item => item.type === 'gate'), 'readding gate 34 restores a derived center outline, not an atomic center item');
  assert.equal(harness.popupCalls.show, 0);
});

test('completing a center through individual Shift clicks only derives its outline and removal or hover never promotes it', t => {
  const harness = graphHarness(t, null);
  const gates = GATES.filter(gate => gate.center === 'heart').map(gate => gate.id);
  for (const id of gates) harness.context.select({ type: 'gate' as const, id: String(id), additive: true });
  assert.deepEqual(JSON.parse(JSON.stringify(harness.context.selectedItems)), gates.map(id => ({ type: 'gate' as const, id })));
  assert.equal(harness.context.selection!.type, 'gate', 'the primary item remains the last individual gate');
  assert.equal(visibleHighlights(harness.viewport.innerHTML).centers.has('heart'), true);
  assert.equal(pressed(harness.viewport.innerHTML).includes('center:heart'), false, 'the inferred outline is not an atomic selected center');
  const removed = gates.at(-1)!;
  harness.context.select({ type: 'gate' as const, id: String(removed), additive: true });
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
  test(`Shift subtraction from ${center.id} removes its outline immediately and readding restores only a derived outline`, t => {
    const harness = graphHarness(t, null);
    const gates = GATES.filter(gate => gate.center === center.id).map(gate => gate.id);
    for (const removed of gates) {
      harness.context.select({ type: 'center' as const, id: center.id });
      harness.hover.move(harness.hover.target('gate', removed, 'design-mercury'));
      harness.context.select({ type: 'gate' as const, id: String(removed), activation: 'design-mercury', additive: true });
      const expected = gates.filter(id => id !== removed).map(id => ({ type: 'gate' as const, id }));
      assert.deepEqual(JSON.parse(JSON.stringify(harness.context.selectedItems)), expected);
      assert.equal(pressed(harness.viewport.innerHTML).includes(`center:${center.id}`), false, 'the explicit center is removed from committed state immediately');
      assert.equal(pressed(harness.viewport.innerHTML).includes(`gate:${removed}`), false, 'the clicked gate is no longer committed even while hovered');
      assert.equal(harness.hover.controller.currentSelection, null, 'subtraction clears the previous hover even on a numeric row');
      assert.equal(visibleHighlights(harness.viewport.innerHTML).centers.has(center.id), false, 'the removed gate immediately breaks the center outline');
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
      harness.context.select({ type: 'gate' as const, id: String(removed), activation: 'design-mercury', additive: true });
      assert.deepEqual(JSON.parse(JSON.stringify(harness.context.selectedItems)), [...expected, { type: 'gate' as const, id: removed, activation: 'design-mercury' }]);
      assert.equal(visibleHighlights(harness.viewport.innerHTML).centers.has(center.id), true, 'readding the missing individual gate restores the automatic outline');
      assert.equal(pressed(harness.viewport.innerHTML).includes(`center:${center.id}`), false);
      assert.equal(harness.activationPopover.currentId, null, 'subtracting or readding within a group never opens percentages');
    }
    assert.equal(harness.popupCalls.show, 0);
  });
}

test('hover alone opens no popup; diagram clicks clear hover and toggle their committed scope immediately', t => {
  const harness = graphHarness(t, null);
  const target = harness.hover.target('center', 'throat');
  harness.hover.move(target);
  assert.equal(harness.context.selection, null);
  assert.equal(harness.activationPopover.currentId, null);
  assert.equal(harness.popupCalls.show, 0);
  harness.context.select({ type: 'center' as const, id: 'throat' });
  assert.deepEqual(harness.context.selection, { type: 'center' as const, id: 'throat' });
  assert.equal(harness.hover.controller.currentSelection, null);
  const pinned = harness.viewport.innerHTML;
  harness.hover.send('svg', 'pointerleave');
  assert.equal(harness.viewport.innerHTML, pinned, 'leaving retains the committed center');
  harness.hover.move(target);
  harness.context.select({ type: 'center' as const, id: 'throat' });
  assert.equal(harness.context.selection, null);
  assert.equal(harness.hover.controller.currentSelection, null);
  assert.equal(harness.activationPopover.currentId, null);
  assert.equal(harness.popupCalls.show, 0, 'diagram selections never enter the numeric detail cycle');
  assert.equal(harness.viewport.innerHTML, renderBodygraph(harness.chart, null, { profile: 'studio', showActivations: true, showBackdrop: true }), 'the second diagram click clears its complete visual scope before pointer leave');
});


test('releasing a deselected center restores its whole hover scope without recommitting it', t => {
  const h = graphHarness(t, null), center = h.hover.target('center', 'g');
  h.hover.move(center);
  h.context.select({ type: 'center', id: 'g', pointerType: 'mouse' });
  h.hover.send('svg', 'pointerup', { target: h.hover.svg });
  h.context.select({ type: 'center', id: 'g', pointerType: 'mouse' });
  h.hover.send('svg', 'pointerup', { target: h.hover.svg });
  assert.equal(h.context.selection, null);
  assert.deepEqual(h.hover.controller.currentSelection, { type: 'center', id: 'g' });
  assert.deepEqual(pressed(h.viewport.innerHTML), [], 'hover never pins the center or its gates');
  assert.equal(h.viewport.innerHTML, renderBodygraph(h.chart, null, {
    profile: 'studio', showActivations: true, showBackdrop: true, selections: [], previewSelection: { type: 'center', id: 'g' },
  }), 'all gates and half-channels follow the center after release');
  h.hover.send('svg', 'pointerleave');
  assert.equal(h.hover.controller.currentSelection, null);
});

test('camera refresh follows the center under the stationary mouse through zoom and captured pan', t => {
  const h = hoverHarness(t), first = h.target('center', 'g'), second = h.target('center', 'throat');
  h.move(first);
  h.send('svg', 'wheel');
  h.controller.refreshCenter();
  assert.deepEqual(h.controller.currentSelection, { type: 'center', id: 'g' });
  const count = h.previews.length;
  h.controller.refreshCenter();
  assert.equal(h.previews.length, count, 'same center does not redraw each camera frame');
  h.classes.add('is-dragging');
  h.move(h.svg, { buttons: 1 });
  h.setHit(second);
  h.controller.refreshCenter();
  assert.deepEqual(h.controller.currentSelection, { type: 'center', id: 'throat' }, 'hit-test ignores the captured event target');
  h.setHit(null);
  h.controller.refreshCenter();
  assert.equal(h.controller.currentSelection, null, 'moving away never leaves a stale center lit');
  h.setHit(first);
  h.controller.refreshCenter();
  assert.deepEqual(h.controller.currentSelection, { type: 'center', id: 'g' });
  h.send('svg', 'pointerleave');
  h.controller.refreshCenter();
  assert.equal(h.controller.currentSelection, null, 'leaving forgets the cursor');
});

test('touch, cancelled gestures and blur cannot resurrect a mouse center preview', t => {
  const h = hoverHarness(t), center = h.target('center', 'g');
  for (const dismiss of [
    () => h.send('svg', 'pointerdown', { pointerType: 'touch' }),
    () => h.send('svg', 'pointercancel'),
    () => h.send('window', 'blur'),
    () => h.controller.clear({ notify: false }),
  ]) {
    h.move(center);
    dismiss();
    h.send('svg', 'pointerup', { pointerType: 'touch' });
    h.controller.refreshCenter();
    assert.equal(h.controller.currentSelection, null);
  }
});


test('retired preview releases listeners and its queued paint without publishing',t=>{
 const owner=new AbortController();let queued:FrameRequestCallback|undefined,cancelled=0;
 const h=hoverHarness(t,{signal:owner.signal,coalesceMandala:true,resolvePreview:()=>({type:'mandala-cross',id:1}),
  requestFrame:callback=>{queued=callback;return 1;},cancelFrame:()=>{cancelled++;}});
 h.move(h.target('gate',41));assert.ok(queued);assert.equal(h.previews.length,0);
 owner.abort();assert.equal(cancelled,1);assert.equal([...h.listeners.values()].flat().length,0);
 queued(0);h.controller.refreshCenter();h.controller.clear();h.move(h.target('gate',19));
 assert.equal(h.previews.length,0);assert.equal(h.controller.currentSelection,null);
});
