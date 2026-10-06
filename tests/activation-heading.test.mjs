import test from 'node:test';
import assert from 'node:assert/strict';
import { createGraphController } from '../src/scene/updates.js';
import { alignPersonalityHeading } from '../src/scene/activation-columns.js';
import { SVG_NS, svgDocument } from './helpers/svg-dom.mjs';

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
    camera: new Matrix(), columnLocal: new Matrix(),
    blockLocal: new Matrix(1.09, 0, 0, 1.09, 428 * (1 - 1.09), 76 * (1 - 1.09) - 15.75),
    valueLocal: new Matrix(1, 0, 0, 1, 584, 118),
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
  const contentMatrix = () => model.camera.multiply(model.columnLocal).multiply(model.blockLocal);
  heading.getCTM = () => model.missing.includes('headingMatrix') ? null : contentMatrix();
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
  number.getCTM = () => model.missing.includes('valueMatrix') ? null : contentMatrix().multiply(model.valueLocal);
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
  column.getCTM = () => model.camera.multiply(model.columnLocal);
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

test('the enlarged and raised column aligns once, independently of camera and mandala travel', () => {
  for (const camera of [new Matrix(), new Matrix(.45, 0, 0, .45, 170, -40), new Matrix(3.2, 0, 0, 3.2, -900, 210)]) {
    for (const offset of [14, 128, 256]) {
      const harness = headingHarness({ camera, columnLocal: new Matrix(1, 0, 0, 1, offset, 0) });
      harness.column.getCTM = () => assert.fail('alignment must use the scaled heading coordinates, not the outer column');
      alignPersonalityHeading(harness.root);
      assertAligned(harness, 661.875);
      const headingEdge = harness.heading.getCTM().transformPoint({ x: 661.875, y: 76 });
      const bounds = harness.number.getBBox();
      const numberEdge = harness.number.getCTM().transformPoint({ x: bounds.x + bounds.width, y: bounds.y });
      assert.ok(Math.abs(headingEdge.x - numberEdge.x) < 1e-9, 'the visible edges stay aligned after one shared scale');
      const first = harness.snapshot();
      alignPersonalityHeading(harness.root);
      assert.deepEqual(harness.snapshot(), first, 'an additional measurement never compounds the scale');
    }
  }
});

test('only the Personality heading anchor and its underline endpoint may change', () => {
  const harness = headingHarness(), before = harness.snapshot();
  alignPersonalityHeading(harness.root);
  const after = harness.snapshot();
  const protectedState = rows => rows.filter(node => !['heading', 'rule'].includes(node.name));
  assert.deepEqual(protectedState(after), protectedState(before), 'numbers, planets, fixing, popover and all other headings stay untouched');
  assert.deepEqual(harness.heading.attrs, { ...before.find(node => node.name === 'heading').attrs, x: harness.heading.attrs.x, 'text-anchor': 'end' });
  assert.deepEqual(harness.rule.attrs, { ...before.find(node => node.name === 'rule').attrs, d: harness.rule.attrs.d });
  assertAligned(harness, 661.875); // Matrix inversion may add a final floating-point digit.
});

test('transit, missing columns, missing Sun and unavailable SVG measurements preserve the fallback unchanged', () => {
  const cases = [
    { label: 'Транзит' }, { label: 'Дизайн' }, { label: '' },
    ...['column', 'heading', 'rule', 'value', 'headingMatrix', 'valueMatrix'].map(key => ({ missing: [key] })),
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

test('persistent scene aligns the retained heading before changed-chart popover refresh without measuring unchanged renders', () => {
  const charts = [12, 1].map((gate, index) => ({ id: String(index), source: 'calculated', personality: [gate], design: [],
    activations: { personality: [{ planet: 'sun', gate, line: index ? 1 : 2 }], design: [] } }));
  let current = charts[0], measurements = 0;
  const viewport = svgDocument().createElementNS(SVG_NS, 'svg');
  const query = viewport.querySelector.bind(viewport), calls = [];
  viewport.querySelector = selector => {
    const result = query(selector);
    if (selector === '.activation-column[data-source="personality"]' && result) {
      const heading = result.querySelector('.activation-heading');
      const value = result.querySelector('[data-activation="personality-sun"] > text');
      heading.getCTM = () => new Matrix();
      heading.getBBox = () => ({ x: Number(heading.getAttribute('x')) - (heading.getAttribute('text-anchor') === 'end' ? 74 : 0), y: 64, width: 74, height: 14 });
      value.getCTM = () => new Matrix(1, 0, 0, 1, 584, 118);
      value.getBBox = () => { measurements++; return { x: 35, y: -9, width: value.textContent === '12.2' ? 43.25 : 28.75, height: 18 }; };
    }
    return result;
  };
  const controller = createGraphController({ viewport, getChart: () => current,
    activationPopover: {
      refresh(chart) {
        const heading = query('.activation-column[data-source="personality"] .activation-heading');
        assert.equal(Number(heading.getAttribute('x')), chart === charts[0] ? 662.25 : 647.75);
        calls.push(chart.id);
      }, close() {},
    },
  });
  controller.render();
  const heading = query('.activation-column[data-source="personality"] .activation-heading');
  assert.equal(measurements, 1);
  controller.render();
  assert.equal(measurements, 1, 'unchanged chart does not repeat SVG geometry reads');
  current = charts[1];
  controller.render();
  assert.equal(query('.activation-column[data-source="personality"] .activation-heading'), heading);
  assert.equal(query('[data-activation="personality-sun"] > text').textContent, '1.1');
  assert.equal(measurements, 2, 'new Sun width updates the existing heading');
  assert.equal(viewport.innerHTMLWrites, 1, 'chart changes do not remount the scene');
  assert.deepEqual(calls, ['0', '1']);
});
