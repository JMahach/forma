import test from 'node:test';
import assert from 'node:assert/strict';
import { createActivationPainter } from '../src/scene/activation-painter.js';
import { renderActivationColumns } from '../src/scene/activation-columns.js';
import { createRenderState } from '../src/scene/render-state.js';
import { PLANETS } from '../src/domain/planets.js';
import { gatePositionAtLongitude } from '../src/domain/gate-wheel.js';
import { ACTIVATION_BLOCK_BOUNDS, ACTIVATION_BLOCK_SCALE, ACTIVATION_COLUMN_LAYOUT, ACTIVATION_PLANET_FILTER_LAYOUT } from '../src/scene/geometry/activation-layout.js';
import { SVG_NS, SvgElement, svgDocument, significantDOM } from './helpers/svg-dom.mjs';

// These node tests compare SVG values and identity. Pixel bounds are covered by
// the browser parity harness, so unavailable SVG matrices simply skip alignment.
SvgElement.prototype.getCTM = () => null;
const options = { showActivations: true };
function chartAt(tick = 0, overrides = {}) {
  const activations = Object.fromEntries(['design', 'personality'].map((source, side) => [source,
    PLANETS.map(([planet], index) => ({ planet, ...gatePositionAtLongitude((index * 23 + side * 143 + tick * 0.31) % 360) }))]));
  return { source: 'calculated', activations,
    personality: [...new Set(activations.personality.map(entry => entry.gate))],
    design: [...new Set(activations.design.map(entry => entry.gate))], ...overrides };
}
function markup(chart, state, opt) {
  return opt.showActivations ? renderActivationColumns(chart, state.relatedGates, state.committedSelection, {
    pressedGates: state.committedGates, pressedSelection: state.committedSelection,
    selections: state.visualSelections, pressedSelections: state.committedSelections,
    activationFilter: opt.activationFilter, previewGates: state.previewGates,
  }) : '';
}
function fixture(chart = chartAt(), selection = null, opt = options) {
  const document = svgDocument(), root = document.createElementNS(SVG_NS, 'svg');
  const state = createRenderState(chart, selection, opt);
  root.innerHTML = `<g class="bodygraph-drawing">${markup(chart, state, opt)}</g>`;
  return { document, root };
}
function assertEquivalent(root, chart, selection = null, opt = options) {
  assert.deepEqual(significantDOM(root.querySelector('.bodygraph-drawing')), significantDOM(fixture(chart, selection, opt).root.querySelector('.bodygraph-drawing')));
}
function update(painter, chart, selection = null, opt = options) { painter.update(chart, createRenderState(chart, selection, opt), opt); }
const targets = root => new Map(root.querySelectorAll('[data-activation]').map(node => [node.dataset.activation, node]));

test('all planetary and numeric targets survive a hundred exact minute changes with the same SVG as full rendering', () => {
  const h = fixture(), painter = createActivationPainter(h.root), initial = targets(h.root);
  update(painter, chartAt()); h.document.parses.length = 0;
  for (let tick = 1; tick <= 100; tick++) {
    const chart = chartAt(tick); update(painter, chart); assertEquivalent(h.root, chart);
    for (const [id, node] of initial) assert.equal(targets(h.root).get(id), node, id);
  }
  for (const parse of h.document.parses) assert.doesNotMatch(parse.markup, /activation-row|activation-column|bg-activation/, 'only a newly appearing decorative fixing may be parsed');
});

test('gate, planet, preview and filtered line selections update paint and ARIA without replacing targets', () => {
  const chart = chartAt(), h = fixture(chart), painter = createActivationPainter(h.root), initial = targets(h.root);
  const gate = chart.activations.design[0].gate, line = chart.activations.design[0].line;
  const cases = [
    [{ type: 'gate', id: gate }, {}],
    [{ type: 'planet', id: 'personality-sun' }, {}],
    [{ type: 'gate', id: gate }, { activationFilter: { groups: [{ source: 'design', line, gates: [gate] }], unfilteredGates: [] } }],
    [{ type: 'gate', id: gate }, { previewSelection: { type: 'center', id: 'root' } }],
    [null, {}],
  ];
  for (const [selection, extra] of cases) {
    const opt = { ...options, ...extra }; update(painter, chart, selection, opt); assertEquivalent(h.root, chart, selection, opt);
    for (const [id, node] of initial) assert.equal(targets(h.root).get(id), node);
  }
});

test('a missing or invalid planet removes only its row; source transitions preserve all surviving targets', () => {
  const base = chartAt(), h = fixture(base), painter = createActivationPainter(h.root), initial = targets(h.root);
  const changed = { ...base, activations: { ...base.activations, design: base.activations.design.map(row => row.planet === 'moon' ? { ...row, gate: -1 } : row) } };
  update(painter, changed); assertEquivalent(h.root, changed);
  assert.equal(targets(h.root).has('design-moon'), false);
  for (const [id, node] of initial) if (!id.startsWith('design-moon')) assert.equal(targets(h.root).get(id), node);
  update(painter, base); assertEquivalent(h.root, base);
  assert.notEqual(targets(h.root).get('design-moon'), initial.get('design-moon'));
  const transit = { ...base, source: 'transit', design: [], activations: { design: [], personality: base.activations.personality } };
  update(painter, transit); assertEquivalent(h.root, transit);
  for (const [id, node] of initial) if (id.startsWith('personality-')) assert.equal(targets(h.root).get(id), node);
  update(painter, base); assertEquivalent(h.root, base);
  for (const [id, node] of initial) if (id.startsWith('personality-')) assert.equal(targets(h.root).get(id), node);
  update(painter, { personality: [], design: [] }); assert.equal(targets(h.root).size, 0);
  update(painter, base); assertEquivalent(h.root, base);
});

test('column visibility creates or removes only column DOM without needing a scene remount', () => {
  const base = chartAt(), h = fixture(base, null, { showActivations: false }), painter = createActivationPainter(h.root), drawing = h.root.firstElementChild;
  update(painter, base); assertEquivalent(h.root, base);
  update(painter, base, null, { showActivations: false }); assertEquivalent(h.root, base, null, { showActivations: false });
  assert.equal(h.root.firstElementChild, drawing);
  update(painter, base); assertEquivalent(h.root, base); assert.equal(h.root.firstElementChild, drawing);
});

test('selection and other planets do not remeasure the Personality heading; a new Sun value does', () => {
  const base = chartAt(), h = fixture(base), painter = createActivationPainter(h.root);
  const heading = h.root.querySelector('.activation-column[data-source="personality"]').querySelector('.activation-heading');
  let reads = 0; heading.getCTM = () => { reads++; return null; };
  update(painter, base); assert.equal(reads, 1);
  update(painter, base, { type: 'center', id: 'root' }); assert.equal(reads, 1);
  const moon = { ...base, activations: { ...base.activations, personality: base.activations.personality.map(row => row.planet === 'moon' ? { ...row, line: row.line % 6 + 1 } : row) } };
  update(painter, moon); assert.equal(reads, 1);
  const sun = { ...base, activations: { ...base.activations, personality: base.activations.personality.map(row => row.planet === 'sun' ? { ...row, line: row.line % 6 + 1 } : row) } };
  update(painter, sun); assert.equal(reads, 2);
});

function planetFilteredChart(base, selectedPlanets) {
  const full = base.activations.personality;
  const personality = full.filter(row => selectedPlanets.includes(row.planet));
  return { ...base, source: 'transit', design: [], personality: [...new Set(personality.map(row => row.gate))],
    activations: { design: [], personality }, planetFilter: { selectedPlanets, activations: full, perPlanetControls: true } };
}

function dualFilteredChart(base, selectedPlanets, selectedDesignPlanets, designActivations = base.activations.design) {
  const chart = planetFilteredChart(base, selectedPlanets);
  const design = designActivations?.filter(entry => selectedDesignPlanets.includes(entry.planet)) || [];
  return { ...chart, design: [...new Set(design.map(entry => entry.gate))], activations: { ...chart.activations, design },
    planetFilter: { ...chart.planetFilter, selectedDesignPlanets, designActivations } };
}

test('Lifetime black and red controls have independent all, mixed and empty states while retaining ordinary targets', () => {
  const base = chartAt(), all = PLANETS.map(([planet]) => planet);
  const h = fixture(base), painter = createActivationPainter(h.root), initial = targets(h.root);
  let controls;
  for (const [black, red, blackMaster, redMaster] of [
    [all, [], 'true', 'false'], [all, ['sun'], 'true', 'mixed'],
    [['moon'], all, 'mixed', 'true'], [[], [], 'false', 'false'], [all, all, 'true', 'true'],
  ]) {
    const chart = dualFilteredChart(base, black, red);
    update(painter, chart); assertEquivalent(h.root, chart);
    assert.equal(h.root.querySelectorAll('.activation-row').length, 26);
    assert.equal(h.root.querySelectorAll('.activation-planet-filter').length, 28);
    assert.equal(h.root.querySelector('.activation-planet-filter[data-id="all"]').getAttribute('aria-checked'), blackMaster);
    assert.equal(h.root.querySelector('.activation-planet-filter[data-id="design:all"]').getAttribute('aria-checked'), redMaster);
    controls ||= new Map(h.root.querySelectorAll('.activation-planet-filter').map(node => [node.dataset.id, node]));
    for (const [id, node] of initial) assert.equal(targets(h.root).get(id), node);
    for (const [source, enabled, prefix] of [['design', red, 'design:'], ['personality', black, '']]) for (const [planet] of PLANETS) {
      const id = `${prefix}${planet}`, control = h.root.querySelector(`.activation-planet-filter[data-id="${id}"]`);
      assert.equal(control, controls.get(id), 'each source keeps its own checkbox node');
      assert.equal(control.getAttribute('aria-checked'), String(enabled.includes(planet)));
      const number = targets(h.root).get(`${source}-${planet}`), glyph = targets(h.root).get(`${source}-${planet}-planet`);
      assert.equal(number.getAttribute('opacity'), enabled.includes(planet) ? null : '.22');
      assert.equal(glyph.getAttribute('opacity'), enabled.includes(planet) ? null : '.35');
      assert.equal(number.getAttribute('tabindex'), '0'); assert.equal(glyph.getAttribute('tabindex'), '0');
      assert.equal(number.getAttribute('pointer-events'), null); assert.equal(glyph.dataset.type, 'planet');
    }
  }
  update(painter, base); assertEquivalent(h.root, base);
  assert.equal(h.root.querySelectorAll('.activation-planet-filter').length, 0, 'an ordinary natal chart keeps both unfiltered columns');
  for (const [id, node] of initial) assert.equal(targets(h.root).get(id), node);
});

test('ordinary day exposes only the Design master and keeps it and every selection target across Lifetime transitions', () => {
  const base = chartAt(), all = PLANETS.map(([planet]) => planet);
  const dayChart = selectedDesignPlanets => {
    const chart = dualFilteredChart(base, all, selectedDesignPlanets);
    delete chart.planetFilter.perPlanetControls;
    return chart;
  };
  const day = dayChart([]), h = fixture(day), painter = createActivationPainter(h.root), initial = targets(h.root);
  const master = h.root.querySelector('.activation-planet-filter');
  assert.equal(master.dataset.id, 'design:all');
  assert.equal(master.dataset.type, 'planet-filter');
  assert.equal(master.getAttribute('role'), 'checkbox');
  assert.equal(master.getAttribute('tabindex'), '0');
  assert.equal(master.getAttribute('aria-checked'), 'false');
  assert.equal(master.parentNode.querySelector('.activation-heading').textContent, 'Дизайн');
  assert.equal(master.parentNode.classList.contains('activation-block-content'), true, 'the one checkbox belongs to the left heading');
  for (const selected of [[], all, [], ['moon']]) {
    const chart = dayChart(selected);
    update(painter, chart); assertEquivalent(h.root, chart);
    assert.deepEqual(h.root.querySelectorAll('.activation-planet-filter'), [master]);
    assert.equal(h.root.querySelectorAll('.activation-row .activation-planet-filter').length, 0);
    assert.equal(master.getAttribute('aria-checked'), selected.length === all.length ? 'true' : selected.length ? 'mixed' : 'false');
    for (const [planet] of PLANETS) {
      assert.equal(targets(h.root).get(`design-${planet}`).getAttribute('opacity'), selected.includes(planet) ? null : '.22');
      assert.equal(targets(h.root).get(`personality-${planet}`).getAttribute('opacity'), null);
    }
  }
  const lifetime = dualFilteredChart(base, ['sun'], ['moon']);
  update(painter, lifetime); assertEquivalent(h.root, lifetime);
  assert.equal(h.root.querySelectorAll('.activation-planet-filter').length, 28);
  assert.equal(h.root.querySelector('.activation-planet-filter[data-id="design:all"]'), master);
  const returnedDay = { ...lifetime, planetFilter: { ...lifetime.planetFilter, perPlanetControls: false } };
  update(painter, returnedDay); assertEquivalent(h.root, returnedDay);
  assert.deepEqual(h.root.querySelectorAll('.activation-planet-filter'), [master]);
  assert.equal(master.getAttribute('aria-checked'), 'mixed', 'presentation changes do not reset either selected set');
  assert.equal(targets(h.root).get('personality-moon').getAttribute('opacity'), '.22', 'the metadata still owns filtering when row controls are hidden');
  for (const [id, node] of initial) assert.equal(targets(h.root).get(id), node, 'all ordinary numeric/glyph targets survive changes of controls');
  update(painter, base); assertEquivalent(h.root, base);
  assert.equal(h.root.querySelectorAll('.activation-planet-filter').length, 0, 'saved ordinary charts have no transit controls');
});

test('red data can arrive after black data without inventing rows or remounting the black controls', () => {
  const base = chartAt(), all = PLANETS.map(([planet]) => planet);
  const pending = dualFilteredChart(base, all, [], []), h = fixture(pending), painter = createActivationPainter(h.root);
  const black = targets(h.root);
  assert.equal(h.root.querySelector('.activation-column[data-source="design"]'), null);
  assert.equal(h.root.querySelectorAll('.activation-planet-filter').length, 14);
  const loaded = dualFilteredChart(base, all, []);
  update(painter, loaded); assertEquivalent(h.root, loaded);
  const full = targets(h.root), redControl = h.root.querySelector('.activation-planet-filter[data-id="design:sun"]');
  assert.equal(h.root.querySelectorAll('.activation-row').length, 26);
  for (const [id, node] of black) assert.equal(full.get(id), node);
  const selected = { type: 'gate', id: base.activations.design[0].gate };
  update(painter, loaded, selected); assertEquivalent(h.root, loaded, selected);
  assert.equal(full.get('design-sun').getAttribute('aria-pressed'), 'true');
  assert.equal(redControl.getAttribute('aria-checked'), 'false', 'selection does not turn the design planet on');
  const moved = dualFilteredChart(chartAt(1), all, ['moon']);
  update(painter, moved); assertEquivalent(h.root, moved);
  for (const [id, node] of full) assert.equal(targets(h.root).get(id), node);
  update(painter, pending); assertEquivalent(h.root, pending);
  assert.equal(h.root.querySelector('.activation-column[data-source="design"]'), null);
  for (const [id, node] of black) assert.equal(targets(h.root).get(id), node);
});

test('both checkbox columns fit inside the activation envelope and remain clear of planet targets', () => {
  const { centerX, size, hitLeft, hitWidth } = ACTIVATION_PLANET_FILTER_LAYOUT;
  assert.equal(size, 13.5); assert.equal(hitWidth, 28);
  assert.ok(centerX + size / 2 <= -14, 'the visible frame leaves extra breathing room before the glyph');
  assert.ok(hitLeft + hitWidth < -8, 'the whole checkbox target ends before the glyph target');
  assert.ok(centerX - size / 2 >= hitLeft && centerX + size / 2 <= hitLeft + hitWidth);
  for (const [source, pivot] of [['design', 212], ['personality', 428]]) {
    const left = pivot + (ACTIVATION_COLUMN_LAYOUT.x[source] + hitLeft - pivot) * ACTIVATION_BLOCK_SCALE;
    const right = left + hitWidth * ACTIVATION_BLOCK_SCALE;
    assert.ok(left >= ACTIVATION_BLOCK_BOUNDS.x, `${source} checkbox fits the shared left bound`);
    assert.ok(right <= ACTIVATION_BLOCK_BOUNDS.x + ACTIVATION_BLOCK_BOUNDS.width, `${source} checkbox fits the shared right bound`);
  }
});

test('inline planet filters keep thirteen rows and stable targets through all, mixed, empty and closed states', () => {
  const base = chartAt(), all = PLANETS.map(([planet]) => planet);
  const ordinary = { ...base, source: 'transit', design: [], activations: { design: [], personality: base.activations.personality } };
  const h = fixture(ordinary), painter = createActivationPainter(h.root), initial = targets(h.root);
  assert.equal(h.root.querySelectorAll('.activation-planet-filter').length, 0);
  let filterTargets;
  for (const [planets, masterChecked] of [[all, 'true'], [['sun', 'moon'], 'mixed'], [[], 'false'], [all, 'true']]) {
    const chart = planetFilteredChart(base, planets);
    update(painter, chart); assertEquivalent(h.root, chart);
    const controls = h.root.querySelectorAll('.activation-planet-filter');
    assert.equal(h.root.querySelectorAll('.activation-row').length, 13, 'unchecked planets retain their original rows');
    assert.equal(controls.length, 14, 'thirteen adjacent controls and one master control');
    assert.equal(h.root.querySelector('.activation-planet-filter[data-id="all"]').getAttribute('aria-checked'), masterChecked);
    filterTargets ||= new Map(controls.map(node => [node.dataset.id, node]));
    for (const control of controls) {
      assert.equal(control, filterTargets.get(control.dataset.id), 'checkboxes keep their identity');
      assert.equal(control.getAttribute('role'), 'checkbox');
      assert.equal(control.getAttribute('tabindex'), '0');
      assert.equal(control.dataset.type, 'planet-filter');
      assert.ok(control.getAttribute('aria-label'));
    }
    for (const [id, node] of initial) assert.equal(targets(h.root).get(id), node, 'ordinary numeric and glyph targets remain stable');
    for (const [planet] of PLANETS) {
      const enabled = planets.includes(planet), number = targets(h.root).get(`personality-${planet}`);
      const glyph = targets(h.root).get(`personality-${planet}-planet`);
      assert.equal(filterTargets.get(planet).getAttribute('aria-checked'), String(enabled));
      assert.equal(number.getAttribute('tabindex'), '0', 'filtered numbers stay keyboard accessible');
      assert.equal(number.getAttribute('pointer-events'), null);
      assert.equal(number.getAttribute('aria-disabled'), null);
      assert.equal(number.getAttribute('opacity'), enabled ? null : '.22');
      assert.equal(glyph.dataset.type, 'planet', 'only the separate checkbox changes the filter');
      assert.equal(glyph.dataset.id, `personality-${planet}`);
    }
  }
  update(painter, ordinary); assertEquivalent(h.root, ordinary);
  assert.equal(h.root.querySelectorAll('.activation-planet-filter').length, 0, 'closing the mode removes all filter controls');
  for (const [id, node] of initial) assert.equal(targets(h.root).get(id), node);
});

test('an initially empty filter can restore every glyph without remounting and keeps checkbox hits separate', () => {
  const base = chartAt(), empty = planetFilteredChart(base, []), h = fixture(empty), initial = targets(h.root);
  const painter = createActivationPainter(h.root), controls = h.root.querySelectorAll('.activation-planet-filter');
  for (const control of controls) {
    const hit = control.querySelector('.activation-planet-filter-hit');
    const frame = control.querySelector('.activation-planet-filter-frame');
    assert.equal(Number(hit.getAttribute('width')), 28);
    assert.ok(Number(hit.getAttribute('x')) + Number(hit.getAttribute('width')) < -8, 'checkbox hit area ends before the glyph hit area');
    assert.equal(frame.getAttribute('width'), '13.5');
    assert.equal(frame.getAttribute('height'), '13.5');
    assert.ok(Number(frame.getAttribute('x')) + Number(frame.getAttribute('width')) < -8, 'the smaller frame stays separate from the planet target');
  }
  const restored = planetFilteredChart(chartAt(5), PLANETS.map(([planet]) => planet));
  update(painter, restored); assertEquivalent(h.root, restored);
  for (const [id, node] of initial) assert.equal(targets(h.root).get(id), node);
  assert.deepEqual(h.root.querySelectorAll('.activation-planet-filter'), controls);
});

test('unchecked planets retain ordinary numeric selection without joining the active chart', () => {
  const base = chartAt();
  base.activations.personality[1] = { ...base.activations.personality[0], planet: 'earth' };
  const chart = planetFilteredChart(base, ['earth']), gate = chart.personality[0];
  const h = fixture(chart, { type: 'gate', id: gate }), painter = createActivationPainter(h.root);
  update(painter, chart, { type: 'gate', id: gate }); assertEquivalent(h.root, chart, { type: 'gate', id: gate });
  assert.equal(targets(h.root).get('personality-sun').getAttribute('data-selected'), 'true');
  assert.equal(targets(h.root).get('personality-sun').getAttribute('aria-pressed'), 'true');
  assert.equal(targets(h.root).get('personality-earth').getAttribute('data-selected'), 'true');
  assert.equal(targets(h.root).get('personality-sun').getAttribute('opacity'), '.22');
  assert.equal(h.root.querySelector('.activation-planet-filter[data-id="sun"]').getAttribute('aria-checked'), 'false');
  assert.deepEqual(chart.activations.personality.map(entry => entry.planet), ['earth']);
  update(painter, chart, { type: 'planet', id: 'personality-sun' });
  assertEquivalent(h.root, chart, { type: 'planet', id: 'personality-sun' });
  const glyph = targets(h.root).get('personality-sun-planet');
  assert.equal(glyph.getAttribute('aria-pressed'), 'true');
  assert.equal(glyph.getAttribute('opacity'), '.35');
  assert.equal(glyph.dataset.type, 'planet');
  assert.equal(h.root.querySelector('.activation-planet-filter[data-id="sun"]').getAttribute('aria-checked'), 'false');
});

test('new exact longitude snapshots skip column preparation while retaining both full filtered source records', () => {
  const all = PLANETS.map(([planet]) => planet), base = chartAt();
  const first = dualFilteredChart(base, all, []), h = fixture(first), painter = createActivationPainter(h.root);
  update(painter, first);
  const initial = targets(h.root), controls = h.root.querySelectorAll('.activation-planet-filter');
  for (let minute = 1; minute <= 120; minute++) {
    const next = structuredClone(base);
    for (const source of ['design', 'personality']) for (const record of next.activations[source]) record.longitude += minute / 1_000_000;
    const chart = dualFilteredChart(next, all, []);
    let rowLookups = 0;
    for (const entries of [chart.planetFilter.activations, chart.planetFilter.designActivations]) {
      entries.find = predicate => { rowLookups++; return Array.prototype.find.call(entries, predicate); };
    }
    update(painter, chart);
    assert.equal(rowLookups, 0, 'unchanged gate/line/fixing/filter inputs never prepare row models');
    assertEquivalent(h.root, chart);
  }
  for (const [id, node] of initial) assert.equal(targets(h.root).get(id), node);
  assert.deepEqual(h.root.querySelectorAll('.activation-planet-filter'), controls);
});

test('column memo observes mutated filtered contributors, full rows, both planet sets, mode, hover and line filters', () => {
  const all = PLANETS.map(([planet]) => planet), chart = dualFilteredChart(chartAt(), all, ['sun']);
  const h = fixture(chart), painter = createActivationPainter(h.root), opt = { ...options, selections: [] };
  const check = label => {
    update(painter, chart, null, opt); assertEquivalent(h.root, chart, null, opt);
    assert.equal(h.root.querySelectorAll('.activation-row').length, 26, label);
  };
  check('initial');
  chart.planetFilter.designActivations[2].gate = 61; check('unchecked red full-record gate');
  chart.planetFilter.activations[2].line = 6; check('black full-record line');
  chart.activations.design = [...chart.activations.design, { planet: 'moon', gate: 61, line: 6 }]; check('new active fixing contributor');
  chart.activations.design.push({ ...chart.activations.design[0] }); check('ambiguous duplicate fixing contributor');
  chart.activations.design.pop(); check('fixed contributor repaired');
  chart.planetFilter.selectedDesignPlanets.push('moon'); check('mutated red enabled set');
  chart.planetFilter.selectedPlanets.splice(0, 1); check('mutated black enabled set');
  chart.planetFilter.perPlanetControls = false; check('Lifetime to ordinary day controls');
  chart.planetFilter.perPlanetControls = true; check('ordinary day to Lifetime controls');
  opt.selections.push({ type: 'planet', id: 'design-moon' }); check('planet selection');
  opt.previewSelection = { type: 'gate', id: 61 }; check('independent hovered gate');
  opt.selections.push({ type: 'gate', id: 61 }); check('committed gate');
  opt.activationFilter = { groups: [{ source: 'design', line: 1, gates: [61] }], unfilteredGates: [] }; check('line filter');
  opt.activationFilter.groups[0].line = 6; check('line filter mutated');
  opt.activationFilter.unfilteredGates.push(61); check('unfiltered gate mutated');
  chart.source = 'calculated'; check('heading source changes');
  chart.planetFilter.designActivations.reverse(); check('full source order changes');
  opt.showActivations = false; update(painter, chart, null, opt); assertEquivalent(h.root, chart, null, opt);
  assert.equal(h.root.querySelectorAll('.activation-row').length, 0);
  opt.showActivations = true; check('hidden columns restored');
});


test('ordinary numeric targets have no native tooltip and share compact highlight height with their planet', () => {
  const chart = chartAt(), h = fixture(chart), painter = createActivationPainter(h.root);
  const selection = { type: 'planet', id: 'personality-sun' };
  const opt = { ...options, previewSelection: { type: 'planet', id: 'design-sun' } };
  update(painter, chart, selection, opt); assertEquivalent(h.root, chart, selection, opt);
  for (const source of ['design', 'personality']) {
    const planet = h.root.querySelector(`[data-activation="${source}-sun-planet"]`);
    const number = h.root.querySelector(`[data-activation="${source}-sun"]`);
    assert.equal(planet.querySelector('rect').getAttribute('fill'), '#eaf0f8');
    assert.equal(planet.getAttribute('aria-pressed'), String(source === 'personality'));
    assert.equal(number.getAttribute('aria-pressed'), 'false');
  }
  for (const row of h.root.querySelectorAll('.activation-row')) {
    const number = row.querySelector('[data-type="gate"]'), planet = row.querySelector('.bg-planet');
    assert.equal(Boolean(number.querySelector('title')), false);
    assert.ok(number.getAttribute('aria-label').includes('ворота'));
    const rect = number.querySelector('rect'), planetRect = planet.querySelector('rect');
    assert.ok(Number(rect.getAttribute('height')) < 40);
    assert.equal(planetRect.getAttribute('y'), rect.getAttribute('y'));
    assert.equal(planetRect.getAttribute('height'), rect.getAttribute('height'));
  }
});
