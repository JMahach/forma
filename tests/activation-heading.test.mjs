import test from 'node:test';
import assert from 'node:assert/strict';
import { createGraphController } from '../src/bodygraph/graph-controller.js';
import { alignPersonalityHeading } from '../src/activations/activations.js';

// Independent affine matrices reproduce SVG's multiply/inverse contract without
// a browser or a camera-specific shortcut in the test expectations.
class Matrix {
  constructor(a = 1, b = 0, c = 0, d = 1, e = 0, f = 0) {
    Object.assign(this, { a, b, c, d, e, f });
  }
  multiply(other) {
    return new Matrix(
      this.a * other.a + this.c * other.b,
      this.b * other.a + this.d * other.b,
      this.a * other.c + this.c * other.d,
      this.b * other.c + this.d * other.d,
      this.a * other.e + this.c * other.f + this.e,
      this.b * other.e + this.d * other.f + this.f,
    );
  }
  inverse() {
    const determinant = this.a * this.d - this.b * this.c;
    if (!determinant) return new Matrix(NaN, NaN, NaN, NaN, NaN, NaN);
    return new Matrix(this.d / determinant, -this.b / determinant, -this.c / determinant, this.a / determinant,
      (this.c * this.f - this.d * this.e) / determinant, (this.b * this.e - this.a * this.f) / determinant);
  }
  transformPoint({ x, y }) {
    return { x: this.a * x + this.c * y + this.e, y: this.b * x + this.d * y + this.f };
  }
}

function headingHarness(options = {}) {
  const model = {
    label: 'Личность', text: '12.2', bounds: { x: 34.65625, y: -9.5, width: 43.21875, height: 18 },
    camera: new Matrix(), valueLocal: new Matrix(1, 0, 0, 1, 584, 118),
    headingRightBearing: 0, missing: [], ...options,
  };
  const writes = [], queries = [], measurements = [];
  function node(name, attributes = {}, textContent = '') {
    return {
      name, attrs: { ...attributes }, textContent,
      setAttribute(key, value) {
        assert.ok(name === 'heading' && ['x', 'text-anchor'].includes(key) || name === 'rule' && key === 'd', name + '.' + key + ' must not change');
        this.attrs[key] = String(value);
        writes.push([name, key, String(value)]);
      },
      getAttribute(key) { return this.attrs[key] ?? null; },
      getBBox() { assert.fail('must not measure ' + name); },
    };
  }
  const heading = node('heading', { class: 'activation-heading', x: '582', y: '76', 'font-size': '16', 'font-weight': '500' }, model.label);
  heading.getCTM = () => model.camera;
  heading.getBBox = () => {
    measurements.push('heading');
    const x = Number(heading.attrs.x);
    // The end anchor follows the advance width, not necessarily the visible ink.
    const advance = 74, leftBearing = 0.75;
    return { x: x - (heading.attrs['text-anchor'] === 'end' ? advance : 0) + leftBearing, y: 64, width: advance - leftBearing - model.headingRightBearing, height: 14 };
  };
  const rule = node('rule', { class: 'activation-header-rule', d: 'M 582 88 h 74', stroke: '#202020', 'stroke-opacity': '.18', 'stroke-width': '1', fill: 'none' });
  const number = node('number', { x: '34', y: '0', 'font-size': '24', 'font-weight': '500', 'pointer-events': 'none' }, model.text);
  number.getBBox = () => { measurements.push('number'); return { ...model.bounds }; };
  number.getCTM = () => model.missing.includes('valueMatrix') ? null : model.camera.multiply(model.valueLocal);
  const protectedNodes = [number,
    node('lineTspan', { 'font-weight': '400', opacity: '.7' }, '.2'),
    node('numericButton', { 'data-activation': 'personality-sun', 'data-type': 'gate', 'data-id': '12', tabindex: '0', role: 'button', 'aria-pressed': 'true' }),
    node('numericHitArea', { x: '28', y: '-20', width: '68', height: '40' }),
    node('planetButton', { 'data-activation': 'personality-sun-planet' }),
    node('fixing', { transform: 'translate(103 0) scale(1.15)', 'pointer-events': 'none' }),
    node('designHeading', { x: '-34', y: '76' }, 'Дизайн'),
    node('designRule', { d: 'M -34 88 h 58' }),
    node('colorHeading', { x: '456', y: '76' }, 'Цвет'),
    node('toneHeading', { x: '528', y: '76' }, 'Тон'),
    node('variableRule', { d: 'M 437 88 H 582' }),
    node('popover', { 'data-anchor': 'personality-sun', open: 'true' }),
  ];
  const column = node('column', { 'data-source': 'personality', fill: '#202020' });
  column.getCTM = () => model.missing.includes('columnMatrix') ? null : model.camera;
  column.querySelector = selector => {
    queries.push(['column', selector]);
    const targets = new Map([
      ['.activation-heading', ['heading', heading]],
      ['.activation-header-rule', ['rule', rule]],
      ['[data-activation="personality-sun"] > text', ['value', number]],
    ]);
    assert.ok(targets.has(selector), 'only the Personality heading, its rule and the Sun numeric text may be queried');
    const [key, result] = targets.get(selector);
    return model.missing.includes(key) ? null : result;
  };
  const root = {
    querySelector(selector) {
      queries.push(['root', selector]);
      assert.equal(selector, '.activation-column[data-source="personality"]', 'the left column is never selected');
      return model.missing.includes('column') ? null : column;
    },
  };
  const snapshot = () => [column, heading, rule, ...protectedNodes].map(item => ({ name: item.name, attrs: { ...item.attrs }, textContent: item.textContent }));
  return { root, model, heading, rule, number, column, protectedNodes, writes, queries, measurements, snapshot };
}

function assertAligned(harness, right) {
  const bbox = harness.heading.getBBox();
  assert.ok(Math.abs(bbox.x + bbox.width - right) < 1e-9, 'the visible heading edge matches the measured numeric edge');
  assert.equal(harness.heading.attrs['text-anchor'], 'end');
  const rule = harness.rule.attrs.d.match(/^M\s*582\s+88\s*H\s*([\d.]+)$/);
  assert.ok(rule, 'the rule keeps its original start and y coordinate');
  assert.ok(Math.abs(Number(rule[1]) - right) < 1e-9, 'the rule endpoint matches the same numeric edge');
}

test('Personality heading uses the measured Sun text, including its line, across different numeric widths', () => {
  for (const [text, x, width, right] of [
    ['12.2', 34.65625, 43.21875, 661.875],
    ['29.1', 35.125, 47.59375, 666.71875],
    ['1.1', 35, 28.75, 647.75],
    ['64.6', 34.25, 48.40625, 666.65625],
  ]) {
    const harness = headingHarness({ text, bounds: { x, y: -9.5, width, height: 18 } });
    alignPersonalityHeading(harness.root);
    assertAligned(harness, right);
    assert.ok(harness.measurements.includes('number'));
    assert.notEqual(right, 680, 'the number button right edge is not used');
    assert.notEqual(right, 691.6, 'the fixing mark right edge is not used');
  }
});

test('shared SVG zoom and pan cancel while the numeric row translation remains', () => {
  for (const camera of [
    new Matrix(), new Matrix(0.65, 0, 0, 0.65, 77, -43), new Matrix(4.5, 0, 0, 4.5, -913, 382),
    new Matrix(1.75, 0.25, -0.4, 2.25, 140, -82),
  ]) {
    const harness = headingHarness({ camera });
    alignPersonalityHeading(harness.root);
    assertAligned(harness, 661.875);
  }
});

test('alignment compensates the heading ink bearing and repeated calls do not drift', () => {
  for (const headingRightBearing of [0, 1.625, -0.375]) {
    const harness = headingHarness({ headingRightBearing });
    alignPersonalityHeading(harness.root);
    assertAligned(harness, 661.875);
    const first = harness.snapshot();
    for (let iteration = 0; iteration < 5; iteration++) alignPersonalityHeading(harness.root);
    assert.deepEqual(harness.snapshot(), first);
    assertAligned(harness, 661.875);
  }
});

test('only the Personality heading anchor and its underline endpoint may change', () => {
  const harness = headingHarness(), before = harness.snapshot();
  alignPersonalityHeading(harness.root);
  const after = harness.snapshot();
  const protectedState = rows => rows.filter(node => !['heading', 'rule'].includes(node.name));
  assert.deepEqual(protectedState(after), protectedState(before), 'numbers, planets, fixing, popover and all other headings stay untouched');
  assert.deepEqual(harness.heading.attrs, { ...before.find(node => node.name === 'heading').attrs, x: '661.875', 'text-anchor': 'end' });
  assert.deepEqual(harness.rule.attrs, { ...before.find(node => node.name === 'rule').attrs, d: 'M 582 88 H 661.875' });
});

test('transit, missing columns, missing Sun and unavailable SVG measurements preserve the fallback unchanged', () => {
  const cases = [
    { label: 'Транзит' }, { label: 'Дизайн' }, { label: '' },
    ...['column', 'heading', 'rule', 'value', 'columnMatrix', 'valueMatrix'].map(key => ({ missing: [key] })),
    ...[0, -1, NaN, Infinity].map(width => ({ bounds: { x: 34, y: -9, width, height: 18 } })),
    { bounds: { x: NaN, y: -9, width: 40, height: 18 } },
    { valueLocal: new Matrix(1, 0, 0, 1, 400, 118) },
    { camera: new Matrix(0, 0, 0, 0, 12, 30) },
  ];
  for (const options of cases) {
    const harness = headingHarness(options), before = harness.snapshot();
    assert.doesNotThrow(() => alignPersonalityHeading(harness.root));
    assert.deepEqual(harness.snapshot(), before);
    assert.deepEqual(harness.writes, [], 'an unusable measurement cannot partially move the heading');
  }
});

test('fresh font metrics and replacement charts are measured again instead of retaining an old right edge', () => {
  let active = headingHarness();
  const root = { querySelector: selector => active.root.querySelector(selector) };
  alignPersonalityHeading(root);
  assertAligned(active, 661.875);
  active.model.bounds.width = 46.71875;
  alignPersonalityHeading(root);
  assertAligned(active, 665.375);
  active = headingHarness({ text: '1.1', bounds: { x: 35, y: -9, width: 28.75, height: 18 } });
  alignPersonalityHeading(root);
  assertAligned(active, 647.75);
  active = headingHarness({ label: 'Транзит' });
  const transit = active.snapshot();
  alignPersonalityHeading(root);
  assert.deepEqual(active.snapshot(), transit);
});

test('actual renderGraph aligns each newly inserted chart before refreshing its unchanged popover', () => {
  const charts = [{ id: 'first' }, { id: 'second' }], calls = [];
  let selectedId = 'first';
  let active, markup = '';
  const viewport = {
    get innerHTML() { return markup; },
    set innerHTML(value) {
      markup = value;
      active = headingHarness(value === 'second' ? { bounds: { x: 35, y: -9, width: 28.75, height: 18 } } : {});
      calls.push('insert:' + value);
    },
    querySelector(selector) { assert.ok(active, 'alignment must follow insertion'); return active.root.querySelector(selector); },
  };
  const controller = createGraphController({
    selectionState: { primary: null, items: [] }, viewport,
    getChart: () => charts.find(chart => chart.id === selectedId),
    renderChart: chart => chart.id, alignHeading: alignPersonalityHeading,
    activationPopover: {
      refresh(chart) { assertAligned(active, chart.id === 'first' ? 661.875 : 647.75); calls.push('refresh:' + chart.id); },
      close() { calls.push('close'); },
    },
  });
  controller.render();
  controller.render();
  selectedId = 'second';
  controller.render();
  assert.deepEqual(calls, ['insert:first', 'refresh:first', 'insert:first', 'refresh:first', 'insert:second', 'refresh:second']);
});
