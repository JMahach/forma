import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CENTERS, GATES } from '../src/scene/geometry/chart-geometry.js';
import { createSelectionState } from '../src/selection/selection-state.js';
import { createGraphController } from '../src/scene/updates.js';

const appSource = readFileSync(new URL('../src/app.js', import.meta.url), 'utf8');

// Exercise the public controller with real selection state and isolated UI
// boundaries. No source extraction, app bootstrap, storage or real charts.
function selectionHarness() {
  const panels = new Map(), opened = [], calls = { graph: 0, details: 0, camera: 0, popupClosed: 0, popupShows: [], events: [], hoverClears: [], updates: 0, libraryCloses: 0 };
  const currentChart = {
    id: 'activation-chart', source: 'calculated', personality: [4], design: [4],
    activations: {
      personality: [{ planet: 'mercury', gate: 4, line: 1 }, { planet: 'mars', gate: 4, line: 4 }],
      design: [{ planet: 'mercury', gate: 4, line: 6 }],
    },
  };
  let currentActivation = null;
  const activationPopover = {
    get currentId() { return currentActivation; },
    close() { currentActivation = null; calls.popupClosed++; calls.events.push('close'); },
    show(chart, id) { currentActivation = id; calls.popupShows.push({ chart, id }); calls.events.push(`show:${id}`); },
    refresh() {},
  };
  const panel = id => {
    if (!panels.has(id)) {
      const classes = new Set();
      let hidden = true, isOpen = false;
      panels.set(id, {
        classList: {
          add(...values) { values.forEach(value => { classes.add(value); if (value === 'is-open' || value === 'open') opened.push(`${id}.${value}`); }); },
          remove(...values) { values.forEach(value => classes.delete(value)); },
          contains: value => classes.has(value),
          toggle(value, force) {
            const enable = force ?? !classes.has(value);
            if (enable) this.add(value); else this.remove(value);
            return enable;
          },
        },
        get hidden() { return hidden; },
        set hidden(value) { hidden = Boolean(value); if (!hidden) opened.push(`${id}.hidden=false`); },
        get open() { return isOpen; },
        set open(value) { isOpen = Boolean(value); if (isOpen) opened.push(`${id}.open=true`); },
        show() { opened.push(`${id}.show()`); isOpen = true; },
        showModal() { opened.push(`${id}.showModal()`); isOpen = true; },
        close() { isOpen = false; },
        scrollTop: 137,
      });
    }
    return panels.get(id);
  };
  const selectionState = createSelectionState();
  let selectedChartId = currentChart.id, liveWanted = false;
  const controller = createGraphController({
    selectionState, getChart: () => currentChart, viewport: panel('viewport'),
    activationPopover,
    getHoverPreview: () => ({ clear(options) { calls.hoverClears.push(options); } }),
    renderChart() { calls.graph++; calls.events.push('graph'); return ''; },
    alignHeading() {},
    onChartChange(id) {
      selectedChartId = id;
      liveWanted = id === 'current-transit';
      calls.updates++;
      calls.libraryCloses++;
    },
  });
  const context = {
    selectionState,
    get selection() { return selectionState.primary; },
    get selectedActivation() { return selectionState.activation; },
    get selectedItems() { return selectionState.items; },
    get selectedChartId() { return selectedChartId; },
    get liveWanted() { return liveWanted; },
    invokeSelection: controller.choose,
    clearSelected: controller.clear,
    selectChart: controller.changeChart,
  };
  return { context, calls, opened, panels, currentChart, activationPopover };
}

test('all graph selection types highlight without automatically opening any information panel', () => {
  const { context, calls, opened, panels } = selectionHarness();
  const values = [
    { type: 'gate', id: '37' },
    { type: 'center', id: 'throat' },
    { type: 'channel', id: '37-40' },
    { type: 'integration', id: 'integration' },
    { type: 'planet', id: 'personality-sun', activation: 'personality-sun-planet' },
    { type: 'planet', id: 'design-earth', activation: 'design-earth-planet' },
    { type: 'gate', id: '10' },
  ];
  for (const [index, value] of values.entries()) {
    context.invokeSelection(value);
    assert.deepEqual(JSON.parse(JSON.stringify(context.selection)), {
      type: value.type, id: value.type === 'gate' ? Number(value.id) : value.id,
    }, `${value.type} selection is retained for highlighting`);
    assert.equal(calls.graph, index + 1, `${value.type} redraws the selected graph`);
    assert.deepEqual(calls.popupShows, [], `${value.type} never opens an activation popup`);
    assert.deepEqual(opened, [], `${value.type} never opens details, library, or a dialog`);
    assert.equal(calls.camera, 0, `${value.type} does not reset or move the camera`);
    for (const [id, panel] of panels) {
      assert.equal(panel.classList.contains('is-open'), false, `${id} remains closed`);
      assert.equal(panel.classList.contains('open'), false, `${id} remains closed`);
      assert.equal(panel.open, false, `${id} remains closed`);
    }
  }
});

test('numeric activation selection opens only its exact source and planet after graph rendering', () => {
  const { context, calls, currentChart, activationPopover, opened } = selectionHarness();
  for (const activation of ['personality-mercury', 'personality-mars', 'design-mercury']) {
    context.invokeSelection({ type: 'gate', id: '4', activation });
    assert.deepEqual(JSON.parse(JSON.stringify(context.selection)), { type: 'gate', id: 4 });
    assert.equal(activationPopover.currentId, activation, 'duplicate gate numbers do not determine the popup identity');
    assert.equal(calls.popupShows.at(-1).chart, currentChart, 'the active chart supplies the activation details');
    assert.equal(calls.popupShows.at(-1).id, activation);
    assert.deepEqual(calls.events.slice(-3), ['close', 'graph', `show:${activation}`], 'the popup anchors to the newly rendered selection');
  }
  assert.equal(calls.popupShows.length, 3);
  assert.equal(calls.graph, 3);
  assert.equal(calls.camera, 0);
  assert.deepEqual(opened, [], 'activation selection leaves the knowledge library and other information panels closed');
});

test('selecting the same numeric activation again closes its popup and a later selection reopens it', () => {
  for (const source of ['personality', 'design']) {
    const { context, calls, activationPopover } = selectionHarness();
    const value = { type: 'gate', id: '4', activation: `${source}-mercury` };
    context.invokeSelection(value);
    assert.equal(activationPopover.currentId, value.activation);
    context.invokeSelection(value);
    assert.equal(activationPopover.currentId, null);
    assert.equal(calls.popupShows.length, 1, 'the second selection does not reopen the popup');
    assert.equal(context.selection, null, 'the second exact click unpins the selected gate');
    assert.equal(context.selectedActivation, null);
    assert.deepEqual(calls.events.slice(-2), ['close', 'graph']);
    context.invokeSelection(value);
    assert.equal(activationPopover.currentId, value.activation);
    assert.equal(calls.popupShows.length, 2);
    assert.equal(calls.graph, 3);
  }
});

test('a second exact graph selection unpins every selection type, and a later click pins it again', () => {
  for (const value of [
    { type: 'gate', id: '37' }, { type: 'center', id: 'throat' },
    { type: 'channel', id: '37-40' }, { type: 'integration', id: 'integration' },
    { type: 'planet', id: 'design-sun', activation: 'design-sun-planet' },
  ]) {
    const { context, calls } = selectionHarness();
    context.invokeSelection(value);
    const pinned = JSON.parse(JSON.stringify(context.selection));
    context.invokeSelection(value);
    assert.equal(context.selection, null, `${value.type} toggles off`);
    assert.equal(context.selectedActivation, null);
    context.invokeSelection(value);
    assert.deepEqual(JSON.parse(JSON.stringify(context.selection)), pinned, `${value.type} can be pinned again`);
    assert.equal(calls.graph, 3);
    assert.deepEqual(calls.popupShows, [], `${value.type} does not open an activation popup`);
  }
});

test('activation identity distinguishes different planets and a diagram gate that share the same gate number', () => {
  const { context, activationPopover } = selectionHarness();
  for (const activation of ['personality-mercury', 'personality-mars', 'design-mercury']) {
    context.invokeSelection({ type: 'gate', id: '4', activation });
    assert.deepEqual(JSON.parse(JSON.stringify(context.selection)), { type: 'gate', id: 4 });
    assert.equal(context.selectedActivation, activation);
    assert.equal(activationPopover.currentId, activation, 'a different activation opens its own details instead of toggling off');
  }
  context.invokeSelection({ type: 'gate', id: '4' });
  assert.deepEqual(JSON.parse(JSON.stringify(context.selection)), { type: 'gate', id: 4 }, 'the diagram gate remains a separate exact click target');
  assert.equal(context.selectedActivation, null);
  assert.equal(activationPopover.currentId, null);
  context.invokeSelection({ type: 'gate', id: '4' });
  assert.equal(context.selection, null);
});

const items = context => JSON.parse(JSON.stringify(context.selectedItems));

test('Shift adds gates 54, 52, 53 and 60, then removes only the matching item while retaining the others', () => {
  const { context, calls } = selectionHarness();
  const expected = [];
  for (const id of [54, 52, 53, 60]) {
    const value = Object.freeze({ type: 'gate', id: String(id), additive: expected.length > 0 });
    context.invokeSelection(value);
    expected.push({ type: 'gate', id });
    assert.deepEqual(items(context), expected);
    assert.deepEqual(JSON.parse(JSON.stringify(context.selection)), { type: 'gate', id }, 'the most recently added item is the primary selection');
    assert.equal(context.selectedActivation, null);
  }
  for (const id of [52, 60, 54, 53]) {
    context.invokeSelection({ type: 'gate', id: String(id), additive: true });
    expected.splice(expected.findIndex(item => item.id === id), 1);
    assert.deepEqual(items(context), expected, 'Shift removes one item instead of clearing the group');
    assert.deepEqual(JSON.parse(JSON.stringify(context.selection)), expected.at(-1) || null);
  }
  assert.deepEqual(calls.popupShows, []);
  assert.equal(calls.camera, 0);
});

test('a normal click replaces a multi-selection even when that target is already the primary item', () => {
  const { context } = selectionHarness();
  context.invokeSelection({ type: 'gate', id: '54' });
  context.invokeSelection({ type: 'gate', id: '52', additive: true });
  context.invokeSelection({ type: 'gate', id: '52' });
  assert.deepEqual(items(context), [{ type: 'gate', id: 52 }], 'a matching primary item in a group becomes the sole selection');
  context.invokeSelection({ type: 'gate', id: '52' });
  assert.deepEqual(items(context), [], 'only an exact repeat of a sole selection toggles off');
  assert.equal(context.selection, null);
  context.invokeSelection({ type: 'gate', id: '54' });
  context.invokeSelection({ type: 'gate', id: '52', additive: true });
  context.invokeSelection({ type: 'center', id: 'throat' });
  assert.deepEqual(items(context), [{ type: 'center', id: 'throat' }]);
});

test('channels remain atomic for their own Shift-selected gates and centers remain atomic for unrelated gates', () => {
  const { context } = selectionHarness();
  for (const [container, gate] of [[{ type: 'center', id: 'throat' }, 29], [{ type: 'channel', id: '37-40' }, 37]]) {
    context.invokeSelection(container);
    context.invokeSelection({ type: 'gate', id: String(gate), additive: true });
    assert.deepEqual(items(context), [container, { type: 'gate', id: gate }], 'a related gate is not implicitly an independent selection');
    context.invokeSelection({ ...container, additive: true });
    assert.deepEqual(items(context), [{ type: 'gate', id: gate }], 'removing the container leaves the explicitly selected gate');
    context.invokeSelection({ type: 'gate', id: String(gate), additive: true });
    assert.deepEqual(items(context), []);
  }
});

for (const center of CENTERS) {
  test(`Shift subtracts any own gate from an explicit ${center.id} center and readding completes its individual selection`, () => {
    const centerGates = GATES.filter(gate => gate.center === center.id).map(gate => ({ type: 'gate', id: gate.id }));
    for (const removed of centerGates) {
      const { context, calls, activationPopover } = selectionHarness();
      context.invokeSelection({ type: 'center', id: center.id });
      const input = Object.freeze({ type: 'gate', id: String(removed.id), activation: 'design-mercury', additive: true });
      context.invokeSelection(input);
      const remaining = centerGates.filter(gate => gate.id !== removed.id);
      assert.deepEqual(items(context), remaining, `gate ${removed.id} is subtracted instead of becoming an extra item`);
      assert.deepEqual(JSON.parse(JSON.stringify(context.selection)), remaining.at(-1));
      assert.equal(context.selectedActivation, null, 'expanded center gates do not acquire a numeric activation identity');
      assert.equal(activationPopover.currentId, null);
      assert.deepEqual(calls.popupShows, [], 'subtracting through a numeric activation never opens its popup');
      assert.deepEqual(calls.events, ['close', 'graph', 'close', 'graph']);
      context.invokeSelection({ type: 'gate', id: String(removed.id), additive: true });
      assert.deepEqual(items(context), [...remaining, removed], 'readding the missing gate preserves individual items without promoting a center');
      assert.equal(calls.camera, 0);
    }
  });
}

test('subtracting a center gate retains unrelated items, removes its explicit duplicate and deduplicates other expanded gates', () => {
  const { context, calls, activationPopover } = selectionHarness();
  const otherGate = { type: 'gate', id: 31, activation: 'personality-mercury' };
  const unrelated = [
    { type: 'gate', id: 29, activation: 'design-mars' },
    { type: 'center', id: 'root' },
    { type: 'channel', id: '37-40' },
    { type: 'planet', id: 'design-sun' },
  ];
  context.invokeSelection({ type: 'gate', id: '20', activation: 'personality-earth' });
  context.invokeSelection({ ...otherGate, additive: true });
  context.invokeSelection({ type: 'center', id: 'throat', additive: true });
  for (const item of unrelated) context.invokeSelection({ ...item, additive: true });
  assert.equal(calls.popupShows.length, 1, 'the first numeric item was the only single-item popup');
  context.invokeSelection({ type: 'gate', id: '20', activation: 'design-earth', additive: true });
  const selected = items(context), keys = selected.map(item => `${item.type}:${item.id}`);
  assert.equal(keys.length, new Set(keys).size, 'expanded gates and previously explicit gates are deduplicated');
  assert.equal(keys.includes('center:throat'), false);
  assert.equal(keys.includes('gate:20'), false, 'the same gate is removed even when both explicit and related to the center');
  assert.deepEqual(selected.find(item => item.type === 'gate' && item.id === 31), otherGate, 'an existing retained gate keeps its activation metadata');
  for (const item of unrelated) assert.deepEqual(selected.find(candidate => candidate.type === item.type && candidate.id === item.id), item);
  assert.deepEqual(new Set(selected.filter(item => item.type === 'gate').map(item => item.id)), new Set([...GATES.filter(gate => gate.center === 'throat' && gate.id !== 20).map(gate => gate.id), 29]));
  const primary = selected.at(-1);
  assert.deepEqual(JSON.parse(JSON.stringify(context.selection)), { type: primary.type, id: primary.id });
  assert.equal(context.selectedActivation, primary.activation || null);
  assert.equal(activationPopover.currentId, null);
  assert.equal(calls.popupShows.length, 1, 'subtracting closes details without reopening a retained activation');
  assert.equal(calls.camera, 0);
});

test('Shift treats numeric copies in different planets, sources and the diagram as the same gate item', () => {
  const { context, activationPopover } = selectionHarness();
  context.invokeSelection({ type: 'gate', id: '4', activation: 'personality-mercury' });
  assert.deepEqual(items(context), [{ type: 'gate', id: 4, activation: 'personality-mercury' }]);
  context.invokeSelection({ type: 'gate', id: '4', activation: 'design-mercury', additive: true });
  assert.deepEqual(items(context), [], 'a different source copy toggles off the existing gate');
  assert.equal(activationPopover.currentId, null);
  context.invokeSelection({ type: 'gate', id: '4', activation: 'personality-mars' });
  context.invokeSelection({ type: 'gate', id: '29', activation: 'design-mars', additive: true });
  context.invokeSelection({ type: 'gate', id: '4', additive: true });
  assert.deepEqual(items(context), [{ type: 'gate', id: 29, activation: 'design-mars' }], 'the diagram copy removes only the matching gate');
  assert.equal(context.selectedActivation, 'design-mars');
  assert.equal(activationPopover.currentId, null, 'removal back to one item does not reopen that item’s popup');
});

test('numeric detail popups open for a newly selected single item and stay hidden throughout multi-selection and removal', () => {
  const { context, calls, activationPopover } = selectionHarness();
  context.invokeSelection({ type: 'gate', id: '4', activation: 'personality-mercury' });
  assert.equal(activationPopover.currentId, 'personality-mercury');
  assert.equal(calls.popupShows.length, 1);
  context.invokeSelection({ type: 'gate', id: '29', activation: 'design-mars', additive: true });
  assert.equal(items(context).length, 2);
  assert.equal(activationPopover.currentId, null, 'adding a second item hides the first popup');
  assert.equal(calls.popupShows.length, 1, 'the second numeric item opens no popup while the group is active');
  context.invokeSelection({ type: 'gate', id: '4', activation: 'design-mercury', additive: true });
  assert.equal(items(context).length, 1);
  assert.equal(context.selectedActivation, 'design-mars');
  assert.equal(activationPopover.currentId, null);
  assert.equal(calls.popupShows.length, 1, 'removing back to one item opens nothing automatically');
  context.invokeSelection({ type: 'center', id: 'throat', additive: true });
  context.invokeSelection({ type: 'gate', id: '29', activation: 'design-mars' });
  assert.deepEqual(items(context), [{ type: 'gate', id: 29, activation: 'design-mars' }]);
  assert.equal(activationPopover.currentId, 'design-mars', 'a normal numeric click replaces the group and opens its own details');
  context.invokeSelection({ type: 'gate', id: '29', activation: 'personality-jupiter' });
  assert.equal(activationPopover.currentId, 'personality-jupiter', 'normal clicking another planet with the same gate updates its popup');
  assert.equal(calls.popupShows.length, 3);
  context.invokeSelection({ type: 'gate', id: '29', activation: 'personality-jupiter' });
  assert.deepEqual(items(context), []);
  assert.equal(activationPopover.currentId, null);
  context.invokeSelection({ type: 'gate', id: '29', activation: 'design-mars', additive: true });
  assert.equal(activationPopover.currentId, 'design-mars', 'Shift can add the first numeric item and open its details');
  assert.equal(calls.popupShows.length, 4);
  context.invokeSelection({ type: 'gate', id: '29', activation: 'design-mars', additive: true });
  assert.deepEqual(items(context), []);
  assert.equal(activationPopover.currentId, null);
  assert.equal(calls.popupShows.length, 4);
});

test('selection items store only normalized fields and keep planet metadata separate from numeric activation details', () => {
  const { context } = selectionHarness();
  context.invokeSelection(Object.freeze({ type: 'gate', id: '54', activation: null, additive: true, ignored: 'event data' }));
  context.invokeSelection(Object.freeze({ type: 'planet', id: 'design-sun', activation: 'design-sun-planet', additive: true }));
  assert.deepEqual(items(context), [{ type: 'gate', id: 54 }, { type: 'planet', id: 'design-sun' }]);
  assert.deepEqual(JSON.parse(JSON.stringify(context.selection)), { type: 'planet', id: 'design-sun' });
  assert.equal(context.selectedActivation, null);
});

test('background clearing and chart changes reset the complete selection list and its primary item', () => {
  for (const action of ['clear', 'chart']) {
    const { context, calls, activationPopover } = selectionHarness();
    context.invokeSelection({ type: 'gate', id: '4', activation: 'personality-mercury' });
    context.invokeSelection({ type: 'center', id: 'throat', additive: true });
    if (action === 'clear') context.clearSelected(); else context.selectChart('another-chart');
    assert.deepEqual(items(context), [], `${action} clears every selected item`);
    assert.equal(context.selection, null);
    assert.equal(context.selectedActivation, null);
    assert.equal(activationPopover.currentId, null);
    assert.equal(calls.hoverClears.length, 1);
    assert.deepEqual(JSON.parse(JSON.stringify(calls.hoverClears[0])), { notify: false });
    if (action === 'chart') {
      assert.equal(context.selectedChartId, 'another-chart');
      assert.equal(calls.updates, 1);
      assert.equal(calls.libraryCloses, 1);
    }
  }
});

test('ordinary graph and planet selections dismiss an open activation popup without opening another panel', () => {
  for (const value of [
    { type: 'gate', id: '4' },
    { type: 'center', id: 'ajna' },
    { type: 'channel', id: '4-63' },
    { type: 'integration', id: 'integration' },
    { type: 'planet', id: 'personality-mercury', activation: 'personality-mercury-planet' },
    { type: 'planet', id: 'design-mercury', activation: 'design-mercury-planet' },
  ]) {
    const { context, calls, activationPopover, opened } = selectionHarness();
    context.invokeSelection({ type: 'gate', id: '4', activation: 'personality-mercury' });
    context.invokeSelection(value);
    assert.equal(activationPopover.currentId, null, `${value.type} dismisses the previous popup`);
    assert.equal(calls.popupShows.length, 1, `${value.type} does not open another activation popup`);
    assert.equal(calls.graph, 2, `${value.type} still updates highlighting`);
    assert.equal(calls.camera, 0, `${value.type} leaves the camera unchanged`);
    assert.deepEqual(opened, [], `${value.type} leaves all information panels closed`);
  }
});

test('pointer and keyboard graph selections use the tested choose callback', () => {
  const options = appSource.match(/attachGestures\(\$\('bodygraph'\),\s*\{([\s\S]*?)\n\}\);/)?.[1];
  assert.ok(options, 'the application attaches gestures to the drawing');
  assert.match(options, /\bonSelect:\s*graph\.choose\s*,/);
  assert.match(options, /\bonBackgroundTap:\s*graph\.clear\s*,/);
});
