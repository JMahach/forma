import test from 'node:test';
import assert from 'node:assert/strict';
import { renderActivationColumns } from '../src/scene/activation-columns.js';
import { createRenderState } from '../src/scene/render-state.js';
import { createActivationPainter } from '../src/scene/activation-painter.js';
import { overlayFixture } from './helpers/chart-composition.mjs';
import { resolveOverlayActivation } from '../src/domain/chart-overlay.js';
import { SVG_NS, SvgElement, svgDocument, significantDOM } from './helpers/svg-dom.mjs';
const RETURN_OVERLAY = { kind: 'return', event: { id: 'fixture-return', body: 'saturn', cycle: 1 } };

SvgElement.prototype.getCTM = () => null;
const natal = { personality: [41], design: [19], activations: {
  personality: [{ planet: 'sun', gate: 41, line: 1, longitude: 302.1 }],
  design: [{ planet: 'sun', gate: 19, line: 2, longitude: 307.8 }],
} };
const cycle = { personality: [41], design: [49], activations: {
  personality: [{ planet: 'sun', gate: 41, line: 6, longitude: 307.1 }],
  design: [{ planet: 'sun', gate: 49, line: 3, longitude: 320.2 }],
} };
const state = { relatedGates: new Set([41]), committedGates: new Set([41]), previewGates: new Set(),
  visualSelections: [], committedSelections: [] };
const options = { showActivations: true };
function fixture(chart, renderOptions = {}, renderState = createRenderState(chart, null, renderOptions)) {
  const document = svgDocument(), root = document.createElementNS(SVG_NS, 'svg');
  root.innerHTML = `<g class="bodygraph-drawing">${renderActivationColumns(chart, renderState.relatedGates, renderState.committedSelection, { ...renderOptions, pressedGates: renderState.committedGates, selections: renderState.visualSelections, pressedSelections: renderState.committedSelections, previewGates: renderState.previewGates })}</g>`;
  return root;
}

test('overlay keeps exact natal and return source values in two side groups at native vertical row anchors', () => {
  const chart = overlayFixture(natal, cycle, RETURN_OVERLAY), root = fixture(chart);
  assert.equal(root.querySelectorAll('[data-cycle-origin]').length, 2);
  for (const [id, gate, line] of [['natal-design-sun', 19, 2], ['natal-personality-sun', 41, 1], ['cycle-design-sun', 49, 3], ['cycle-personality-sun', 41, 6]]) {
    const node = root.querySelector(`[data-activation="${id}"]`);
    assert.ok(node, id);
    assert.equal(node.dataset.id, String(gate));
    assert.equal(node.querySelector('text').textContent, `${gate}.${line}`);
    assert.equal(resolveOverlayActivation(chart, id).entry, id.startsWith('natal') ? natal.activations[id.includes('design') ? 'design' : 'personality'][0] : cycle.activations[id.includes('design') ? 'design' : 'personality'][0]);
  }
  const rows = root.querySelector('[data-cycle-origin="natal"]').querySelectorAll('[data-cycle-planet]');
  assert.equal(rows[0].getAttribute('transform'), 'translate(-46 118)');
  assert.equal(rows[1].getAttribute('transform'), 'translate(-46 166)');
  assert.match(root.textContent, /Личная карта/); assert.match(root.textContent, /Возврат/);
});

test('both source columns retain red natal and black cycle paint for all four exact sources', () => {
  const root = fixture(overlayFixture(natal, cycle, RETURN_OVERLAY));
  for (const [origin, paint] of [['natal', '#c32d35'], ['cycle', '#202020']]) {
    const column = root.querySelector(`[data-cycle-origin="${origin}"]`);
    assert.equal(column.querySelector('.activation-heading').getAttribute('fill'), paint);
    for (const node of column.querySelectorAll('.planet-symbol')) assert.equal(node.getAttribute('fill'), paint);
    for (const node of column.querySelectorAll('text[font-size="10"]')) assert.equal(node.getAttribute('fill'), paint);
    for (const source of ['design', 'personality']) assert.equal(column.querySelector(`[data-cycle-source="${origin}-${source}"]`).getAttribute('fill'), paint);
  }
});

test('overlay painter retains exact source targets, observes changed return values, and restores native columns', () => {
  const root = fixture(natal), painter = createActivationPainter(root);
  const chart = overlayFixture(natal, cycle, RETURN_OVERLAY);
  painter.update(chart, state, options);
  const node = root.querySelector('[data-activation="cycle-personality-sun"]'); assert.ok(node);
  const changed = overlayFixture(natal, { ...cycle, activations: { ...cycle.activations, personality: [{ planet: 'sun', gate: 42, line: 2 }] } }, RETURN_OVERLAY);
  painter.update(changed, state, options);
  assert.equal(root.querySelector('[data-activation="cycle-personality-sun"]'), node);
  assert.equal(node.dataset.id, '42'); assert.equal(node.querySelector('text').textContent, '42.2');
  painter.update(changed, state, { showActivations: false });
  assert.equal(root.querySelector('.activation-columns'), null);
  painter.update(natal, state, options);
  assert.equal(root.querySelector('[data-cycle-origin]'), null);
  assert.ok(root.querySelector('[data-activation="personality-sun"]'));
});

test('natal line filters select only exact natal rows while hover spans matching return gates', () => {
  const root = fixture(overlayFixture(natal, cycle, RETURN_OVERLAY)), painter = createActivationPainter(root);
  painter.update(overlayFixture(natal, cycle, RETURN_OVERLAY), state, { ...options, activationFilter: { source: 'personality', line: 1, gates: [41] } });
  assert.equal(root.querySelector('[data-activation="natal-personality-sun"]').getAttribute('aria-pressed'), 'true');
  const other = root.querySelector('[data-activation="cycle-personality-sun"]');
  assert.equal(other.getAttribute('aria-pressed'), 'false');
  painter.update(overlayFixture(natal, cycle, RETURN_OVERLAY), { ...state, previewGates: new Set([41]) }, { ...options, activationFilter: { source: 'personality', line: 1, gates: [41] } });
  assert.equal(other.dataset.selected, 'true');
});


test('an adopted overlay retains surviving targets when exact source values disappear and arrive', () => {
  const chart = overlayFixture(natal, cycle, RETURN_OVERLAY), root = fixture(chart), painter = createActivationPainter(root);
  const surviving = root.querySelector('[data-activation="natal-personality-sun"]');
  const missing = overlayFixture(natal, { ...cycle, activations: { personality: [], design: [{ planet: 'sun', gate: 49, line: 0 }] } }, RETURN_OVERLAY);
  painter.update(missing, state, options);
  assert.equal(root.querySelector('[data-activation="cycle-personality-sun"]'), null);
  assert.equal(root.querySelector('[data-activation="cycle-design-sun"]'), null);
  assert.equal(root.querySelector('[data-activation="natal-personality-sun"]'), surviving);
  painter.update(chart, state, options);
  assert.equal(root.querySelector('[data-activation="natal-personality-sun"]'), surviving);
  assert.equal(root.querySelector('[data-activation="cycle-design-sun"]').querySelector('text').textContent, '49.3');
  assert.equal(root.querySelectorAll('.activation-columns').length, 1);
});


test('return and transit overlays update surviving headings, exact source captions and rows in place', () => {
  const returning = overlayFixture(natal, cycle, RETURN_OVERLAY), transit = overlayFixture(natal, cycle, { kind: 'transit' });
  const root = fixture(returning), painter = createActivationPainter(root);
  const heading = root.querySelector('[data-cycle-origin="cycle"] .activation-heading');
  const target = root.querySelector('[data-activation="cycle-personality-sun"]');
  for (const [chart, label] of [[transit, 'Транзит'], [returning, 'Возврат'], [transit, 'Транзит']]) {
    painter.update(chart, state, options);
    assert.equal(root.querySelector('[data-cycle-origin="cycle"] .activation-heading'), heading);
    assert.equal(heading.textContent, label);
    assert.equal(root.querySelector('[data-activation="cycle-personality-sun"]'), target);
    assert.match(target.getAttribute('aria-label'), new RegExp(label));
    assert.equal(resolveOverlayActivation(chart, 'cycle-personality-sun').label, `${label} · Личность`);
    assert.equal(resolveOverlayActivation(chart, 'cycle-design-sun').label, `${label} · Дизайн`);
    assert.equal(resolveOverlayActivation(chart, 'natal-design-sun').label, 'Личная карта · Дизайн');
  }
});

test('a personality-only transit fills one native-size column without an empty Design slot', () => {
  const transit = { ...cycle, design: [], activations: { design: [], personality: cycle.activations.personality } };
  const root = fixture(overlayFixture(natal, transit, { kind: 'transit' }));
  const column = root.querySelector('[data-cycle-origin="cycle"]');
  const value = column.querySelector('[data-activation="cycle-personality-sun"]');
  assert.equal(column.querySelector('[data-cycle-source="cycle-design"]'), null);
  assert.equal(value.querySelector('text').getAttribute('font-size'), '24');
  assert.equal(value.getAttribute('transform'), 'translate(34 0)');
  assert.equal(value.querySelector('rect').getAttribute('width'), '68');
  assert.equal(column.querySelector('.planet-symbol').getAttribute('font-size'), '26');
  assert.equal(column.querySelector('.cycle-source-headings').getAttribute('display'), 'none');
});

test('dual number highlights have equal size and meet without overlap in normal and mandala views', () => {
  for (const showMandala of [false, true]) {
  const root = fixture(overlayFixture(natal, cycle, RETURN_OVERLAY), { showMandala });
  for (const origin of ['natal', 'cycle']) {
    const row = root.querySelector(`[data-cycle-origin="${origin}"] [data-cycle-planet="sun"]`);
    const boxes = [...row.querySelectorAll('.cycle-activation-value')].map(value => {
      const x = Number(/translate\(([-\d.]+) 0\)/.exec(value.getAttribute('transform'))[1]);
      const rect = value.querySelector('rect');
      return { left: x + Number(rect.getAttribute('x')), right: x + Number(rect.getAttribute('x')) + Number(rect.getAttribute('width')),
        width: Number(rect.getAttribute('width')), height: Number(rect.getAttribute('height')) };
    });
    assert.equal(boxes[0].right, boxes[1].left, 'neighboring highlights share a border without a gap or overlap');
    assert.equal(boxes[0].width, boxes[1].width, 'both source highlights have the same width');
    assert.equal(boxes[0].height, boxes[1].height, 'both source highlights have the same height');
    assert.ok(boxes[0].left >= 20 && boxes[1].right <= (showMandala ? 120 : 136), 'both complete targets stay inside the expanded column envelope');
    assert.equal(row.querySelector('.cycle-activation-value text').getAttribute('font-size'), showMandala ? '18' : '20');
  }
  }
});

test('single and dual transitions preserve rows and targets while matching complete rendering', () => {
  const returning = overlayFixture(natal, cycle, RETURN_OVERLAY);
  const transit = overlayFixture(natal, { ...cycle, design: [], activations: { design: [], personality: cycle.activations.personality } }, { kind: 'transit' });
  const root = fixture(returning), painter = createActivationPainter(root);
  const row = root.querySelector('[data-cycle-origin="cycle"] [data-cycle-planet="sun"]');
  const target = root.querySelector('[data-activation="cycle-personality-sun"]');
  const empty = { ...state, relatedGates: new Set(), committedGates: new Set() };
  for (const chart of [transit, returning, transit]) {
    painter.update(chart, empty, options);
    assert.equal(root.querySelector('[data-cycle-origin="cycle"] [data-cycle-planet="sun"]'), row);
    assert.equal(root.querySelector('[data-activation="cycle-personality-sun"]'), target);
    assert.deepEqual(significantDOM(root.querySelector('.cycle-activation-columns')),
      significantDOM(fixture(chart).querySelector('.cycle-activation-columns')));
  }
});

test('longitude-only motion does not reread or rewrite retained overlay column nodes', () => {
  const root = fixture(overlayFixture(natal, cycle, RETURN_OVERLAY)), painter = createActivationPainter(root);
  painter.update(overlayFixture(natal, cycle, RETURN_OVERLAY), state, options);
  const nodes = [...root.querySelector('.cycle-activation-columns').querySelectorAll('*')];
  let reads = 0, writes = 0;
  for (const node of nodes) {
    const get = node.getAttribute.bind(node), set = node.setAttribute.bind(node);
    node.getAttribute = name => { reads++; return get(name); };
    node.setAttribute = (name, value) => { writes++; set(name, value); };
  }
  painter.update(overlayFixture(natal, { ...cycle, activations: { ...cycle.activations,
    personality: [{ ...cycle.activations.personality[0], longitude: 307.10001 }] } }, RETURN_OVERLAY), state, options);
  assert.equal(reads, 0);
  assert.equal(writes, 0);
});

test('normal and mandala layouts retain their rows and match fresh rendering on each switch', () => {
  const chart = overlayFixture(natal, cycle, RETURN_OVERLAY), root = fixture(chart), painter = createActivationPainter(root);
  const row = root.querySelector('[data-cycle-origin="natal"] [data-cycle-planet="sun"]');
  const target = root.querySelector('[data-activation="natal-personality-sun"]');
  const empty = { ...state, relatedGates: new Set(), committedGates: new Set() };
  for (const showMandala of [true, false, true]) {
    painter.update(chart, empty, { ...options, showMandala });
    assert.equal(root.querySelector('[data-cycle-origin="natal"] [data-cycle-planet="sun"]'), row);
    assert.equal(root.querySelector('[data-activation="natal-personality-sun"]'), target);
    assert.deepEqual(significantDOM(root.querySelector('.cycle-activation-columns')),
      significantDOM(fixture(chart, { showMandala }).querySelector('.cycle-activation-columns')));
  }
});

test('the first standalone update paints changed input with or without an initial rendered snapshot', () => {
  for (const adopt of [false, true]) {
    const chart = structuredClone(overlayFixture(natal, cycle, RETURN_OVERLAY)), root = fixture(chart);
    const empty = { ...state, relatedGates: new Set(), committedGates: new Set() };
    const painter = createActivationPainter(root, adopt ? { chart, state: empty, options } : undefined);
    const target = root.querySelector('[data-activation="cycle-personality-sun"]');
    Object.assign(chart.secondary.activations.personality[0], { gate: 42, line: 2 });
    painter.update(chart, empty, options);
    assert.equal(root.querySelector('[data-activation="cycle-personality-sun"]'), target);
    assert.equal(target.dataset.id, '42');
    assert.equal(target.querySelector('text').textContent, '42.2');
    assert.deepEqual(significantDOM(root.querySelector('.cycle-activation-columns')),
      significantDOM(fixture(chart).querySelector('.cycle-activation-columns')));
  }
});

test('chart names remain escaped text and a rename refreshes retained overlay headings and exact source captions', () => {
  const first = overlayFixture({ ...natal, name: 'Марат <g> & "друг"' }, cycle, RETURN_OVERLAY);
  const root = fixture(first), painter = createActivationPainter(root);
  const heading = root.querySelector('[data-cycle-origin="natal"] .activation-heading');
  const target = root.querySelector('[data-activation="natal-personality-sun"]');
  assert.equal(heading.textContent, first.primary.name);
  assert.equal(heading.querySelector('g'), null, 'user names never become SVG markup');
  assert.ok(target.getAttribute('aria-label').startsWith(`${first.primary.name},`));
  painter.update(first, state, options);
  const second = overlayFixture({ ...natal, name: 'Анна <svg> & "имя"' }, cycle, RETURN_OVERLAY);
  painter.update(second, state, options);
  assert.equal(root.querySelector('[data-cycle-origin="natal"] .activation-heading'), heading);
  assert.equal(root.querySelector('[data-activation="natal-personality-sun"]'), target);
  assert.equal(heading.textContent, second.primary.name);
  assert.ok(target.getAttribute('aria-label').startsWith(`${second.primary.name},`));
  assert.equal(Boolean(target.querySelector('title')), false, 'numeric targets retain accessible text without a native tooltip');
});

test('a full length chart name retains its font size and accessible text within the existing column envelope', () => {
  const chart = overlayFixture({ ...natal, name: 'Ш'.repeat(80) }, cycle, RETURN_OVERLAY);
  const root = fixture(chart), painter = createActivationPainter(root);
  for (const showMandala of [false, true, false]) {
    painter.update(chart, state, { ...options, showMandala });
    const column = root.querySelector('[data-cycle-origin="natal"]');
    const viewport = column.querySelector('.activation-heading-viewport');
    assert.ok(viewport);
    assert.equal(viewport.getAttribute('overflow'), 'hidden');
    assert.equal(viewport.getAttribute('width'), showMandala ? '109' : '123');
    assert.equal(viewport.getAttribute('aria-label'), chart.primary.name);
    assert.equal(viewport.querySelector('title').textContent, chart.primary.name);
    const heading = column.querySelector('.activation-heading');
    assert.equal(heading.textContent, chart.primary.name);
    assert.equal(heading.getAttribute('font-size'), '16');
    assert.equal(heading.getAttribute('textLength'), null);
    const fresh = fixture(chart, { showMandala });
    assert.deepEqual(significantDOM(viewport), significantDOM(fresh.querySelector('[data-cycle-origin="natal"] .activation-heading-viewport')));
  }
});


test('overlay planets hover and toggle independently of numbers with stable targets and full-render parity', () => {
  const chart = overlayFixture(natal, cycle, RETURN_OVERLAY);
  const root = fixture(chart), painter = createActivationPainter(root);
  const targets = new Map(root.querySelectorAll('[data-activation]').map(node => [node.dataset.activation, node]));
  const natalPlanet = { type: 'planet', id: 'natal-sun' }, cyclePlanet = { type: 'planet', id: 'cycle-sun' };
  for (const showMandala of [false, true, false]) for (const selection of [
    { selections: [natalPlanet] },
    { selections: [natalPlanet], previewSelection: cyclePlanet },
    { selections: [natalPlanet, cyclePlanet] },
    { selections: [cyclePlanet] },
    { selections: [] },
  ]) {
    const opt = { ...options, showMandala, ...selection }, selected = createRenderState(chart, null, opt);
    painter.update(chart, selected, opt);
    for (const origin of ['natal', 'cycle']) {
      const planet = root.querySelector(`[data-activation="${origin}-sun-planet"]`);
      assert.ok(planet, `${origin} exposes its own planet target`);
      assert.equal(planet.dataset.type, 'planet');
      assert.equal(planet.dataset.id, `${origin}-sun`);
      assert.equal(planet.getAttribute('role'), 'button');
      assert.equal(planet.getAttribute('tabindex'), '0');
      assert.equal(planet.getAttribute('aria-pressed'), String(selection.selections.some(item => item.id === `${origin}-sun`)));
      const highlighted = selected.visualSelections.some(item => item.id === `${origin}-sun`);
      assert.equal(planet.querySelector('rect').getAttribute('fill'), highlighted ? '#eaf0f8' : 'transparent');
      assert.equal(Boolean(planet.querySelector('title')), false, 'a new planet target adds no hover popup');
      for (const source of ['design', 'personality']) {
        const value = root.querySelector(`[data-activation="${origin}-${source}-sun"]`);
        assert.equal(value.getAttribute('aria-pressed'), 'false', 'planet selection never selects either number');
        assert.equal(value.querySelector('rect').getAttribute('fill'), 'transparent');
        assert.equal(Boolean(value.querySelector('title')), false);
        assert.ok(value.getAttribute('aria-label').includes('ворота'));
        assert.equal(value, targets.get(`${origin}-${source}-sun`));
      }
      assert.equal(planet, targets.get(`${origin}-sun-planet`));
    }
    assert.deepEqual(significantDOM(root.querySelector('.cycle-activation-columns')),
      significantDOM(fixture(chart, opt, selected).querySelector('.cycle-activation-columns')));
  }
});

test('overlay target heights follow number size and stay aligned and separated through layout changes', () => {
  const returning = overlayFixture(natal, cycle, RETURN_OVERLAY);
  const transit = overlayFixture(natal, { ...cycle, design: [], activations: { design: [], personality: cycle.activations.personality } }, { kind: 'transit' });
  const root = fixture(returning), painter = createActivationPainter(root);
  const planet = root.querySelector('[data-activation="cycle-sun-planet"]');
  let singleHeight;
  for (const [chart, showMandala] of [[transit, false], [returning, false], [returning, true], [transit, true]]) {
    const opt = { ...options, showMandala };
    painter.update(chart, createRenderState(chart, null, options), opt);
    const row = root.querySelector('[data-cycle-origin="cycle"] [data-cycle-planet="sun"]');
    const target = row.querySelector('.bg-planet');
    assert.ok(target, 'planet has its own highlight and hit area');
    assert.equal(target, planet);
    const planetRect = target.querySelector('rect');
    const values = row.querySelectorAll('.cycle-activation-value');
    for (const value of values) {
      const rect = value.querySelector('rect');
      const height = Number(rect.getAttribute('height'));
      assert.ok(height < 40 && height >= Number(value.querySelector('text').getAttribute('font-size')), 'highlight is compact without cutting the numeral');
      assert.equal(planetRect.getAttribute('y'), rect.getAttribute('y'));
      assert.equal(planetRect.getAttribute('height'), rect.getAttribute('height'));
      if (values.length === 1) singleHeight = height;
      else {
        assert.ok(height < singleHeight, 'smaller numbers get a smaller highlight');
        assert.ok(118 + Number(rect.getAttribute('y')) > 101 + 2, 'first row leaves space below source captions');
      }
    }
    const first = values[0], firstLeft = Number(/translate\(([-\d.]+) 0\)/.exec(first.getAttribute('transform'))[1]) + Number(first.querySelector('rect').getAttribute('x'));
    assert.ok(Number(planetRect.getAttribute('x')) + Number(planetRect.getAttribute('width')) < firstLeft, 'planet and number hit areas never overlap');
    assert.ok(Number(target.querySelector('text').getAttribute('y')) > Number(first.querySelector('text').getAttribute('y')), 'symbol receives a small downward optical correction');
    assert.deepEqual(significantDOM(root.querySelector('.cycle-activation-columns')), significantDOM(fixture(chart, opt).querySelector('.cycle-activation-columns')));
  }
});

test('empty overlay rows keep decorative glyphs without invented planet targets, and activate in place when data arrives', () => {
  const chart = overlayFixture(natal, cycle, RETURN_OVERLAY), root = fixture(chart), painter = createActivationPainter(root);
  const row = root.querySelector('[data-cycle-origin="cycle"] [data-cycle-planet="moon"]');
  assert.equal(row.querySelector('[data-type="planet"]'), null);
  assert.ok(row.querySelector('.planet-symbol'));
  const changed = overlayFixture(natal, { ...cycle, activations: { ...cycle.activations, personality: [...cycle.activations.personality, { planet: 'moon', gate: 1, line: 1 }] } }, RETURN_OVERLAY);
  painter.update(changed, createRenderState(changed, null, options), options);
  assert.equal(root.querySelector('[data-cycle-origin="cycle"] [data-cycle-planet="moon"]'), row);
  assert.ok(row.querySelector('[data-type="planet"]'));
  painter.update(chart, createRenderState(chart, null, options), options);
  assert.equal(row.querySelector('[data-type="planet"]'), null);
  assert.equal(row.querySelector('[tabindex="0"]'), null);
});

test('the public renderer preserves single planet selections and explicit preview overrides in overlays', () => {
  const chart = overlayFixture(natal, cycle, RETURN_OVERLAY);
  const selection = { type: 'planet', id: 'cycle-sun' };
  for (const [renderOptions, selected, pressed] of [[{}, true, true], [{ pressedSelection: null }, true, false], [{ selections: [], pressedSelections: [] }, false, false]]) {
    const document = svgDocument(), root = document.createElementNS(SVG_NS, 'svg');
    root.innerHTML = renderActivationColumns(chart, new Set(), selection, renderOptions);
    const target = root.querySelector('[data-activation="cycle-sun-planet"]');
    assert.equal(target.querySelector('rect').getAttribute('fill'), selected ? '#eaf0f8' : 'transparent');
    assert.equal(target.getAttribute('aria-pressed'), String(pressed));
    assert.equal(root.querySelector('[data-activation="natal-sun-planet"]').getAttribute('aria-pressed'), 'false');
  }
});
