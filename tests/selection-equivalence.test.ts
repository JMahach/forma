import type { ChartInput } from '../src/domain/chart-composition.ts';
import type { SelectionAction, SelectionSnapshot } from '../src/selection/selection-targets.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createContext, runInContext } from 'node:vm';
import { createSelectionState } from '../src/selection/selection-state.ts';
import { renderBodygraph } from '../src/scene/bodygraph-svg.ts';
import { CENTERS, GATES } from '../src/scene/geometry/chart-geometry.ts';
import { chooseSource, clearSelectionSource, changeChartSource } from './fixtures/selection-before-refactor.ts';

// This oracle executes only the frozen, pre-refactor function bodies. It must
// never import the new controller or extract its expected behavior from app.ts.
// All chart data and UI effects below are in-memory test doubles.
const chart = {
  id: 'selection-equivalence-fixture', source: 'calculated' as const,
  personality: [4, 10, 20, 29, 31, 34, 37, 52, 54, 57, 60],
  design: [4, 19, 20, 29, 40, 41, 53, 57],
  activations: {
    personality: [
      { planet: 'sun', gate: 20, line: 1 }, { planet: 'earth', gate: 20, line: 2 },
      { planet: 'moon', gate: 31, line: 3 }, { planet: 'mercury', gate: 4, line: 1 },
      { planet: 'venus', gate: 37, line: 5 }, { planet: 'mars', gate: 4, line: 4 },
    ],
    design: [
      { planet: 'sun', gate: 20, line: 3 }, { planet: 'earth', gate: 20, line: 4 },
      { planet: 'moon', gate: 29, line: 5 }, { planet: 'mercury', gate: 4, line: 6 },
      { planet: 'venus', gate: 40, line: 1 }, { planet: 'mars', gate: 29, line: 2 },
    ],
  },
} as unknown as ChartInput & { id: string };
const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value));

function legacyState() {
  const context = createContext({
    GATES, selection: null, selectedItems: [], selectedActivation: null,
    selectedChartId: chart.id, liveWanted: false,
    chart: () => chart,
    activationPopover: {
      close() {}, show() {},
    },
    hoverPreview: { clear() {} },
    renderGraph() {}, updatePage() {}, closeLibrary() {},
  });
  runInContext(`${chooseSource}\n${clearSelectionSource}\n${changeChartSource}`, context);
  return {
    choose(value: SelectionAction) { context.choose(value); },
    clear() { context.clearSelection(); },
    changeChart(id: string) { context.changeChart(id); },
    get items() { return plain(context.selectedItems) as SelectionSnapshot['items']; },
    get primary() { return plain(context.selection) as SelectionSnapshot['primary']; },
    get activation() { return context.selectedActivation as string | null; },
  };
}

const snapshot = (state: SelectionSnapshot) => plain({ items: state.items, primary: state.primary, activation: state.activation });
function pair() {
  const oldState = legacyState(), newState = createSelectionState();
  const assertSame = (label: string|Error|undefined) => assert.deepEqual(snapshot(newState), snapshot(oldState), label);
  assertSame('initial state');
  return {
    oldState, newState, assertSame,
    choose(value: SelectionAction, label = JSON.stringify(value)) {
      const input = Object.freeze({ ...value });
      newState.choose(input); oldState.choose(input);
      assertSame(`${label}: items, primary and activation`);
    },
    clear(label = 'clear') {
      oldState.clear(); newState.clear(); assertSame(label);
    },
  };
}

const gate = (id: number, activation?: string, additive = false) => ({
  type: 'gate' as const, id: String(id), ...(activation ? { activation } : {}), additive,
});
const add = (value: SelectionAction) => ({ ...value, additive: true });
const center = (id: string) => ({ type: 'center' as const, id });
const channel = (id: string) => ({ type: 'channel' as const, id });
const planet = (id: string) => ({ type: 'planet' as const, id, activation: `${id}-planet` });
const integration = { type: 'integration' as const, id: 'integration' };
const centerGates = (id: string) => GATES.filter(item => item.center === id).map(item => gate(item.id));

const scenarios: [string, SelectionAction[]][] = [
  ['ordinary selection replacement and exact repeat', [
    gate(54), gate(54), gate(52), add(gate(53)), gate(53), gate(53), gate(60),
  ]],
  ['ordered Shift addition and removal', [
    gate(54), add(gate(52)), add(gate(53)), add(gate(60)), add(gate(52)), add(gate(60)),
  ]],
  ['same gate on separate activation rows and on the diagram', [
    gate(4, 'personality-mercury'), gate(4, 'personality-mars'), gate(4, 'design-mercury'),
    gate(4), gate(4), gate(4, 'personality-mercury'), gate(4, 'personality-mercury'),
  ]],
  ['Shift removes a gate across activation sources without reopening the survivor', [
    gate(4, 'personality-mercury'), gate(29, 'design-mars', true),
    gate(4, 'design-mercury', true), gate(4, 'personality-mars', true), add(gate(4)),
  ]],
  ['activation identity after replacing a group', [
    gate(4, 'personality-mercury', true), gate(29, 'design-mars', true),
    gate(4, 'design-mercury', true), add(center('throat')), gate(29, 'design-mars'),
  ]],
  ['explicit center subtraction', [center('throat'), add(gate(20))]],
  ['center subtraction retains activation metadata and deduplicates', [
    gate(20, 'personality-earth'), gate(31, 'personality-moon', true), add(center('throat')),
    gate(29, 'design-mars', true), add(center('root')), add(channel('37-40')),
    add(planet('design-sun')), gate(20, 'design-earth', true),
  ]],
  ['center added before explicit same-center gates are subtracted', [
    gate(31, 'personality-moon'), add(center('throat')), gate(20, 'design-sun', true),
    add(gate(31)), add(gate(20)),
  ]],
  ['all individual center gates produce automatic center highlighting', centerGates('root').map(add)],
  ['automatic center can become incomplete and complete again', [
    ...centerGates('root').map(add), add(gate(52)), add(gate(52)),
  ]],
  ['atomic channels, integration and planet selection', [
    channel('37-40'), add(gate(37)), add(channel('37-40')), add(integration),
    add(channel('10-20')), add(planet('personality-mercury')), add(planet('design-mercury')),
    add(integration),
  ]],
  ['integration gate pairs and crossing selections', [
    gate(10), add(gate(34)), add(gate(20)), add(gate(57)), add(gate(20)), add(gate(10)),
  ]],
];

for (const [name, sequence] of scenarios) {
  test(`selection matches frozen behavior: ${name}`, () => {
    const states = pair();
    sequence.forEach((value, index) => states.choose(value, `${name}, step ${index + 1}`));
    states.clear();
    states.clear('repeated clear');
    states.choose(gate(4, 'design-mercury', true), 'first activation after clear');
  });
}

test('every center gate subtracts and re-adds with original ordering and no state promotion', () => {
  for (const { id } of CENTERS) {
    const gates = centerGates(id);
    for (const removed of gates) {
      const states = pair();
      states.choose(center(id));
      states.choose(add(removed));
      assert.equal(states.newState.items.some(item => item.type === 'center'), false);
      states.choose(add(removed));
      assert.equal(states.newState.items.length, gates.length);
      assert.equal(states.newState.items.some(item => item.type === 'center'), false,
        'automatic center highlighting must not promote individual state items');
      states.choose(add(removed));
    }
  }
});

test('retained gate activation and first-occurrence order survive center expansion in either ordering', () => {
  for (const { id } of CENTERS) {
    const [removed, retained] = centerGates(id);
    for (const explicitFirst of [false, true] as const) {
      const states = pair();
      const duplicate = { ...retained, activation: 'personality-moon' };
      // A center must be added after its explicit gate. The unrelated item can
      // occur on either side to check Map insertion order during expansion.
      const unrelated = channel('37-40');
      const sequence = explicitFirst
        ? [duplicate, unrelated, center(id)] : [unrelated, duplicate, center(id)];
      sequence.forEach(value => states.choose(add(value)));
      states.choose(add(removed));
      assert.equal(states.newState.items.find(item => item.type === 'gate'
        && item.id === Number(retained.id))!.activation, 'personality-moon');
      assert.equal(new Set(states.newState.items.map(item => `${item.type}:${item.id}`)).size,
        states.newState.items.length);
    }
  }
});

test('clear reproduces background and chart-change selection resets, including empty state', () => {
  for (const cleanup of ['clear', 'changeChart'] as const) {
    for (const sequence of [[], [gate(4, 'personality-mercury')], scenarios[6][1]] as const) {
      const states = pair();
      sequence.forEach(value => states.choose(value));
      Reflect.apply(states.oldState[cleanup], states.oldState, ['another-test-chart']);
      states.newState.clear();
      states.assertSame(cleanup);
      assert.deepEqual(snapshot(states.newState), { items: [], primary: null, activation: null });
      states.choose(gate(4, 'personality-mercury'), `select after ${cleanup}`);
    }
  }
});

// Derive the randomized input vocabulary from actual rendered interactive
// targets, so numeric activation and planet IDs remain valid UI values.
const initialMarkup = renderBodygraph(chart, null, { showActivations: true });
const uiTargets = [...initialMarkup.matchAll(/<g\b[^>]*\bdata-type="[^"]+"[^>]*>/g)].map(([tag]) => {
  const attribute = (name: string) => tag.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1];
  const activation = attribute('data-activation');
  return { type: attribute('data-type'), id: attribute('data-id'), ...(activation ? { activation } : {}) } as SelectionAction;
});

test('all actual UI targets preserve ordinary and Shift toggling', () => {
  assert.ok(uiTargets.length > 100, 'graph and both activation columns provide UI input coverage');
  assert.deepEqual(new Set(uiTargets.map(item => item.type)),
    new Set(['gate', 'center', 'channel', 'integration', 'planet']));
  for (const target of uiTargets) {
    const states = pair();
    for (const value of [target, target, add(target), add(target), gate(54), add(target), target] as const) {
      states.choose(value);
    }
  }
});

test('deterministic mixed UI sequences preserve every selection state transition', () => {
  for (let seed = 1; seed <= 32; seed++) {
    let randomState = seed;
    const random = () => {
      randomState ^= randomState << 13;
      randomState ^= randomState >>> 17;
      randomState ^= randomState << 5;
      return randomState >>> 0;
    };
    const states = pair();
    let previous = uiTargets[0];
    for (let step = 0; step < 160; step++) {
      const label = `seed ${seed}, step ${step}`;
      if (random() % 23 === 0) { states.clear(label); continue; }
      const target = random() % 4 === 0 ? previous : uiTargets[random() % uiTargets.length];
      previous = target;
      states.choose({ ...target, additive: random() % 4 !== 0 }, label);
    }
  }
});

test('full SVG is identical for legacy and module selections, including hover and restoration', () => {
  const previews = [null, { type: 'gate' as const, id: 20 }, center('throat'), channel('37-40'), integration];
  for (const [name, sequence] of scenarios) {
    const states = pair();
    sequence.forEach(value => states.choose(value));
    const before = snapshot(states.newState);
    let committedMarkup;
    for (const previewSelection of [...previews, null] as const) {
      const render = (state: SelectionSnapshot) => renderBodygraph(chart, state.primary, {
        selections: state.items, showActivations: true, previewSelection,
      });
      const oldMarkup = render(states.oldState), newMarkup = render(states.newState);
      assert.equal(newMarkup, oldMarkup, `${name}, preview ${JSON.stringify(previewSelection)}`);
      if (committedMarkup === undefined) committedMarkup = newMarkup;
      else if (previewSelection === null) assert.equal(newMarkup, committedMarkup, `${name}: hover restoration`);
      assert.deepEqual(snapshot(states.newState), before, `${name}: hover does not mutate committed state`);
    }
    states.clear();
    assert.equal(renderBodygraph(chart, states.newState.primary, { selections: states.newState.items, showActivations: true }),
      renderBodygraph(chart, states.oldState.primary, { selections: states.oldState.items, showActivations: true }),
      `${name}: full SVG after clear`);
  }
});

test('separate selection controllers do not share mutable state', () => {
  const first = createSelectionState(), second = createSelectionState();
  first.choose(gate(4, 'personality-mercury'));
  second.choose(center('root'));
  first.clear();
  assert.deepEqual(snapshot(first), { items: [], primary: null, activation: null });
  assert.deepEqual(snapshot(second), {
    items: [{ type: 'center' as const, id: 'root' }], primary: { type: 'center' as const, id: 'root' }, activation: null,
  });
});
