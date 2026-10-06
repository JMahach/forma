import test from 'node:test';
import assert from 'node:assert/strict';
import { overlayFixture } from './helpers/chart-composition.mjs';
import { OVERLAY_SOURCES } from '../src/domain/chart-overlay.js';
import { PLANETS } from '../src/domain/planets.js';
import { gatePositionAtLongitude } from '../src/domain/gate-wheel.js';
import { mandalaPlanetEntries, mandalaGateSets, mandalaSectorPaint } from '../src/scene/mandala-paint-rules.js';
import { MANDALA_SECTORS, MANDALA_GEOMETRY } from '../src/scene/geometry/mandala-geometry.js';
import { layoutMandalaPlanets, MANDALA_PLANET_LAYOUT } from '../src/scene/geometry/mandala-planets.js';
import { renderMandala } from '../src/scene/mandala.js';
import { createMandalaPainter } from '../src/scene/mandala-painter.js';
import { SVG_NS, svgDocument, significantDOM } from './helpers/svg-dom.mjs';
const RETURN_OVERLAY = { kind: 'return', event: { id: 'fixture-return', body: 'saturn', cycle: 1 } };
const chart = (angle = 45) => {
  const position = gatePositionAtLongitude(angle);
  return { source: 'calculated', personality: [position.gate], design: [position.gate],
    activations: Object.fromEntries(['design', 'personality'].map(source => [source,
      PLANETS.map(([planet]) => ({ planet, ...position }))])) };
};
const rendered = chart => {
  const document = svgDocument(), root = document.createElementNS(SVG_NS, 'svg');
  root.innerHTML = renderMandala(chart);
  return root;
};
test('overlay sectors show two origins while retaining all four exact activation sources', () => {
  const natal = chart(), cycle = chart(), overlay = overlayFixture(natal, cycle, RETURN_OVERLAY);
  const entries = mandalaPlanetEntries(overlay);
  assert.equal(entries.length, 52);
  for (const source of OVERLAY_SOURCES) assert.equal(entries.filter(entry => entry.source === source.id).length, 13);
  const sector = MANDALA_SECTORS.find(item => item.gate === natal.personality[0]);
  const paint = mandalaSectorPaint(sector, mandalaGateSets(overlay), new Set(), new Set());
  assert.deepEqual(paint.sources.map(item => item.source), ['natal', 'cycle']);
  assert.deepEqual(paint.sources.map(item => item.color), ['#c32d35', '#202020']);
  assert.deepEqual(paint.sources.map(item => item.ring), sector.halfRings);
  const onlyNatal = overlayFixture(natal, { personality: [], design: [] }, RETURN_OVERLAY);
  const own = mandalaSectorPaint(sector, mandalaGateSets(onlyNatal), new Set(), new Set());
  assert.equal(own.sources.length, 1); assert.equal(own.sources[0].ring, sector.ring);
  assert.equal(own.color, '#c32d35');
});

test('overlay planetary projection does not rebuild unrelated topology or source captions', () => {
  let gateReads = 0, labelReads = 0;
  const observed = () => new Proxy(chart(), { get(target, key, receiver) {
    if (key === 'personality' || key === 'design') gateReads++;
    if (key === 'name') labelReads++;
    return Reflect.get(target, key, receiver);
  } });
  const overlay = overlayFixture(observed(), observed(), RETURN_OVERLAY);
  gateReads = labelReads = 0;
  const entries = mandalaPlanetEntries(overlay);
  assert.equal(entries.length, 52);
  assert.deepEqual(entries.filter(entry => entry.planet === 'sun'), [
    { source: 'natal-personality', planet: 'sun', longitude: 45, origin: 'natal', lane: 'personality', shared: true },
    { source: 'natal-design', planet: 'sun', longitude: 45, origin: 'natal', lane: 'design', shared: true },
    { source: 'cycle-personality', planet: 'sun', longitude: 45, origin: 'cycle', lane: 'personality', shared: true },
    { source: 'cycle-design', planet: 'sun', longitude: 45, origin: 'cycle', lane: 'design', shared: true },
  ]);
  assert.equal(gateReads, 0, 'exact rays read activations, not topology unions');
  assert.equal(labelReads, 0, 'planet origin identities do not need formatted captions');
});

test('all four mandala sources use natal red and return black across rays, fans and labels', () => {
  const root = rendered(overlayFixture(chart(), chart(), RETURN_OVERLAY));
  for (const [origin, color] of [['natal', '#c32d35'], ['cycle', '#202020']]) {
    assert.equal(root.querySelector(`.mandala-fan[data-mandala-source="${origin}"]`).getAttribute('fill'), color);
    assert.equal(root.querySelector(`.mandala-source[data-mandala-source="${origin}"]`).getAttribute('fill'), color);
    for (const source of ['personality', 'design']) {
      const marker = root.querySelector(`.mandala-planet-marker[data-source="${origin}-${source}"]`);
      assert.equal(marker.querySelector('.mandala-planet-ray').getAttribute('stroke'), color);
      assert.equal(marker.querySelector('.mandala-planet-endpoint').getAttribute('fill'), color);
      assert.equal(marker.querySelector('.mandala-planet-leader').getAttribute('stroke'), color);
      assert.equal(root.querySelector(`.mandala-planet-symbol[data-source="${origin}-${source}"]`).getAttribute('fill'), color);
    }
  }
});
test('ordinary and overlay planetary rays stay solid with the original emphasis', () => {
  for (const input of [chart(), overlayFixture(chart(), chart(95), RETURN_OVERLAY)]) {
    const root = rendered(input);
    for (const marker of root.querySelectorAll('.mandala-planet-marker')) {
      const ray = marker.querySelector('.mandala-planet-ray');
      const cross = ['sun', 'earth'].includes(marker.getAttribute('data-mandala-planet'));
      assert.equal(ray.getAttribute('stroke-dasharray'), null);
      assert.equal(ray.getAttribute('stroke-dashoffset'), null);
      assert.equal(ray.getAttribute('stroke-width'), cross ? '.8' : '.55');
      assert.equal(ray.getAttribute('stroke-opacity'), cross ? '.64' : '.4');
    }
  }
});
test('all 52 coincident overlay glyphs preserve exact angles and fit without collisions', () => {
  const entries = mandalaPlanetEntries(overlayFixture(chart(), chart(), RETURN_OVERLAY));
  assert.equal(entries.length, 52);
  const labels = layoutMandalaPlanets(entries);
  assert.equal(labels.length, 52);
  assert.deepEqual(layoutMandalaPlanets([...entries].reverse()).map(entry => [entry.source, entry.planet, entry.x, entry.y]).sort(),
    labels.map(entry => [entry.source, entry.planet, entry.x, entry.y]).sort());
  for (const label of labels) {
    assert.equal(label.longitude, 45);
    const radius = Math.hypot(label.x - MANDALA_GEOMETRY.centerX, label.y - MANDALA_GEOMETRY.centerY);
    assert.ok(radius + MANDALA_PLANET_LAYOUT.glyphRadius <= MANDALA_PLANET_LAYOUT.visualRadius + .001);
  }
  for (let a = 0; a < labels.length; a++) for (let b = a + 1; b < labels.length; b++)
    assert.ok(Math.hypot(labels[a].x - labels[b].x, labels[a].y - labels[b].y) >= 21 - .002);
});
test('overlay painter matches full rendering across ownership-only changes and exit with stable targets', () => {
  const natal = chart(), cycle = chart(95), root = rendered(natal), painter = createMandalaPainter(root);
  const targets = [...root.querySelectorAll('.mandala-gate')];
  for (const input of [overlayFixture(natal, cycle, RETURN_OVERLAY), overlayFixture(cycle, natal, RETURN_OVERLAY),
      overlayFixture(natal, chart(), RETURN_OVERLAY), overlayFixture(natal, chart(45.0001), RETURN_OVERLAY), natal]) {
    assert.equal(painter.update(input), true);
    assert.deepEqual(significantDOM(root.querySelector('.bodygraph-mandala')), significantDOM(rendered(input).querySelector('.bodygraph-mandala')));
    assert.deepEqual([...root.querySelectorAll('.mandala-gate')], targets);
  }
});
test('coincident natal and return endpoints remain visibly split without moving astronomical rays', () => {
  const root = rendered(overlayFixture(chart(), chart(), RETURN_OVERLAY));
  const natal = root.querySelector('[data-source="natal-personality"][data-mandala-planet="sun"]');
  const cycle = root.querySelector('[data-source="cycle-personality"][data-mandala-planet="sun"]');
  assert.ok(natal && cycle);
  assert.equal(natal.querySelector('.mandala-planet-ray').getAttribute('d'), cycle.querySelector('.mandala-planet-ray').getAttribute('d'));
  assert.notEqual(natal.querySelector('.mandala-planet-endpoint').getAttribute('d'), cycle.querySelector('.mandala-planet-endpoint').getAttribute('d'));
});

test('an exact Saturn return with numerical residual splits the displayed endpoint and preserves both longitudes', () => {
  const natalLongitude = 33.62152416176548, returnLongitude = 33.62152416177608;
  const saturn = longitude => ({ source: 'calculated', design: [], personality: [24],
    activations: { design: [], personality: [{ planet: 'saturn', ...gatePositionAtLongitude(longitude) }] } });
  const overlay = overlayFixture(saturn(natalLongitude), saturn(returnLongitude), RETURN_OVERLAY);
  const root = rendered(overlay), painterRoot = rendered(saturn(natalLongitude)), painter = createMandalaPainter(painterRoot);
  assert.equal(painter.update(overlay), true);
  for (const output of [root, painterRoot]) {
    const natal = output.querySelector('[data-source="natal-personality"][data-mandala-planet="saturn"]');
    const cycle = output.querySelector('[data-source="cycle-personality"][data-mandala-planet="saturn"]');
    assert.equal(natal.getAttribute('data-longitude'), String(natalLongitude));
    assert.equal(cycle.getAttribute('data-longitude'), String(returnLongitude));
    assert.equal(natal.querySelector('.mandala-planet-ray').getAttribute('d'), cycle.querySelector('.mandala-planet-ray').getAttribute('d'));
    const natalDisc = natal.querySelector('.mandala-planet-endpoint'), cycleDisc = cycle.querySelector('.mandala-planet-endpoint');
    assert.equal((natalDisc.getAttribute('d').match(/ A /g) || []).length, 1);
    assert.equal((cycleDisc.getAttribute('d').match(/ A /g) || []).length, 1);
    assert.notEqual(natalDisc.getAttribute('d'), cycleDisc.getAttribute('d'));
    assert.equal(natalDisc.getAttribute('fill'), '#c32d35');
    assert.equal(cycleDisc.getAttribute('fill'), '#202020');
  }
  // Once the planet has visibly moved, restore both complete discs in place.
  const moved = overlayFixture(saturn(natalLongitude), saturn(33.622), RETURN_OVERLAY);
  assert.equal(painter.update(moved), true);
  for (const endpoint of painterRoot.querySelectorAll('.mandala-planet-endpoint'))
    assert.equal((endpoint.getAttribute('d').match(/ A /g) || []).length, 2);
  assert.deepEqual(significantDOM(painterRoot.querySelector('.bodygraph-mandala')),
    significantDOM(rendered(moved).querySelector('.bodygraph-mandala')));
});
