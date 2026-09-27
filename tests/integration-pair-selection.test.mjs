import test from 'node:test';
import assert from 'node:assert/strict';
import { renderBodygraph } from '../src/scene/bodygraph-svg.js';
import { CHANNELS, GATES } from '../src/scene/geometry/chart-geometry.js';
import { PLANETS } from '../src/domain/planets.js';
import { INTEGRATION_ARMS, STEM_POINTS } from '../src/scene/geometry/integration-geometry.js';
import { INTEGRATION_IDS } from '../src/domain/topology.js';

const gate = id => ({ type: 'gate', id });
const center = id => ({ type: 'center', id });
const channel = id => ({ type: 'channel', id });
const integrationGates = [10, 20, 34, 57];
const centerForGate = { 10: 'g', 20: 'throat', 34: 'sacral', 57: 'spleen' };
const integrationPairs = CHANNELS.filter(item => INTEGRATION_IDS.has(item.id));
const stemPath = STEM_POINTS.map(([x, y], index) => `${index ? 'L' : 'M'}${x.toFixed(2)},${y.toFixed(2)}`).join(' ');
const render = (chart, selections, previewSelection = null) => renderBodygraph(chart, null, { selections, previewSelection, showActivations: true });
const attribute = (tag, name) => tag.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1];
const pathParts = path => path.split(/(?=M)/).map(item => item.trim()).filter(Boolean);

const chartStates = [
  ['inactive', { personality: [], design: [] }],
  ['black', { personality: [...integrationGates, 37, 40], design: [] }],
  ['red', { personality: [], design: [...integrationGates, 37, 40] }],
  ['dual', { personality: [...integrationGates, 37, 40], design: [...integrationGates, 37, 40] }],
  ['mixed', { personality: [10, 20, 37], design: [34, 57, 40] }],
];

function targets(markup) {
  const starts = [...markup.matchAll(/<g\b[^>]*\bdata-type="[^"]+"[^>]*>/g)];
  return starts.map((match, index) => ({
    tag: match[0], type: attribute(match[0], 'data-type'), id: attribute(match[0], 'data-id'),
    activation: attribute(match[0], 'data-activation'),
    content: markup.slice(match.index + match[0].length, starts[index + 1]?.index ?? markup.length),
  }));
}

const graphPressed = markup => new Set(targets(markup)
  .filter(target => !target.activation && attribute(target.tag, 'aria-pressed') === 'true')
  .map(target => `${target.type}:${target.id}`));
const allPressed = markup => new Set(targets(markup)
  .filter(target => attribute(target.tag, 'aria-pressed') === 'true')
  .map(target => target.activation || `${target.type}:${target.id}`));

function integrationOutline(markup) {
  const element = markup.match(/<path class="bg-integration-selection"[^>]*\/>/)?.[0];
  assert.ok(element, 'the selected integration route has an outline');
  const maskId = attribute(element, 'mask')?.match(/^url\(#([^)]*)\)$/)?.[1];
  assert.ok(maskId, 'the route uses an ownership mask');
  const mask = [...markup.matchAll(/<mask\b[^>]*>[\s\S]*?<\/mask>/g)]
    .find(match => attribute(match[0], 'id') === maskId)?.[0];
  assert.ok(mask, 'the referenced ownership mask exists');
  return { element, path: attribute(element, 'd'), mask };
}

function permanentArtwork(markup) {
  const body = markup.replace(/<defs>[\s\S]*?<\/defs>/, '');
  return {
    sourceAndOutlinePaths: [...body.matchAll(/<path\b[^>]*stroke="(?:#202020|#c32d35|#c6c2b9|#ffffff)"[^>]*\/>/g)].map(match => match[0]),
    shapes: [...body.matchAll(/<(?:path|circle)\b[^>]*class="bg-(?:channel-outline|center-shape|gate-disc)"[^>]*\/>/g)].map(match => match[0]),
    clipPaths: [...markup.matchAll(/<clipPath\b[^>]*>[\s\S]*?<\/clipPath>/g)].map(match => match[0]),
    positions: [...body.matchAll(/<g\b[^>]*transform="[^"]+"[^>]*>/g)].map(match => attribute(match[0], 'transform')),
    columnPaint: [...body.matchAll(/<g class="activation-column"[^>]*>/g)].map(match => match[0]),
    hitShapes: [...body.matchAll(/<(?:path|circle)\b[^>]*pointer-events="(?:all|stroke)"[^>]*\/>/g)].map(match => match[0]),
    targets: targets(markup).map(target => [target.type, target.id, target.activation, attribute(target.tag, 'tabindex'), attribute(target.tag, 'role'), attribute(target.tag, 'aria-label')]),
  };
}

for (const pair of integrationPairs) {
  test(`selected integration gates ${pair.id} use their channel's exact path and mask in either order and every paint state`, () => {
    const crossesStem = [10, 20].includes(pair.gates[0]) !== [10, 20].includes(pair.gates[1]);
    for (const [state, chart] of chartStates) {
      const explicit = integrationOutline(render(chart, [channel(pair.id)]));
      const baseline = permanentArtwork(render(chart, []));
      for (const ids of [pair.gates, [...pair.gates].reverse()]) {
        const markup = render(chart, ids.map(gate)), actual = integrationOutline(markup);
        assert.deepEqual(actual, explicit, `${pair.id}, ${state}: the two selected gates use the existing channel outline`);
        const paths = pathParts(actual.path);
        assert.equal(paths.filter(path => path === stemPath).length, Number(crossesStem), `${pair.id}: only routes crossing the node include the common stem`);
        assert.equal(paths.length, 2 + Number(crossesStem));
        assert.equal(/class="bg-integration-owned-stem"/.test(actual.mask), crossesStem);
        assert.deepEqual(new Set([...actual.mask.matchAll(/data-owner-gate="(\d+)"/g)].map(([, id]) => Number(id))), new Set(pair.gates), 'mask ownership remains limited to the selected arms');
        assert.deepEqual(graphPressed(markup), new Set(pair.gates.map(id => `gate:${id}`)), 'the inferred route does not press a channel or the complete integration');
        assert.match(markup, /data-junction="integration" data-visual-selected="false"/);
        assert.deepEqual(permanentArtwork(markup), baseline, `${state}: geometry, source colors and hit targets remain unchanged`);
      }
    }
  });
}

test('hovering the second gate previews each complete route without pinning it, and leave restores the first arm', () => {
  const chart = chartStates.find(([state]) => state === 'mixed')[1];
  for (const pair of integrationPairs) {
    for (const [first, second] of [pair.gates, [...pair.gates].reverse()]) {
      const selections = [gate(first)], baseline = render(chart, selections);
      const hovered = render(chart, selections, gate(second));
      assert.deepEqual(integrationOutline(hovered), integrationOutline(render(chart, [channel(pair.id)])));
      assert.deepEqual(graphPressed(hovered), new Set([`gate:${first}`]));
      assert.deepEqual(allPressed(hovered), allPressed(baseline));
      assert.equal(render(chart, selections, null), baseline, 'ending hover removes the second arm and any inferred stem');
      assert.equal(pathParts(integrationOutline(baseline).path).length, 1);
      assert.equal(pathParts(integrationOutline(baseline).path).includes(stemPath), false);
      const committedPair = render(chart, [gate(first), gate(second)]);
      assert.deepEqual(integrationOutline(committedPair), integrationOutline(hovered));
      assert.equal(render(chart, [gate(first)]), baseline, 'removing the second committed gate restores the same original arm');
    }
  }
});

test('three or four selected integration gates deduplicate shared arms and stem without selecting channels', () => {
  const chart = chartStates.find(([state]) => state === 'dual')[1];
  for (const ids of [...integrationGates.map(removed => integrationGates.filter(id => id !== removed)), integrationGates]) {
    const completeChannels = integrationPairs.filter(pair => pair.gates.every(id => ids.includes(id))).map(pair => channel(pair.id));
    const markup = render(chart, ids.map(gate)), outline = integrationOutline(markup);
    assert.deepEqual(outline, integrationOutline(render(chart, completeChannels)), 'the selected gates share the existing routes of all completed integration channels');
    const parts = pathParts(outline.path);
    assert.equal(parts.length, ids.length + 1);
    assert.equal(parts.length, new Set(parts).size);
    assert.equal(parts.filter(path => path === stemPath).length, 1);
    assert.deepEqual(graphPressed(markup), new Set(ids.map(id => `gate:${id}`)));
    assert.match(markup, /data-junction="integration" data-visual-selected="false"/);
    assert.deepEqual(integrationOutline(render(chart, [...ids].reverse().map(gate))), outline);
    assert.deepEqual(integrationOutline(render(chart, [...ids, ids[0]].map(gate))), outline, 'repeated explicit gate data does not duplicate the route');
    const baseline = render(chart, ids.slice(0, -1).map(gate));
    const hovered = render(chart, ids.slice(0, -1).map(gate), gate(ids.at(-1)));
    assert.deepEqual(integrationOutline(hovered), outline);
    assert.deepEqual(allPressed(hovered), allPressed(baseline));
  }
});

function numericFixture() {
  const gates = [20, 20, 57, 57, 10, 10, 34, 34, 29];
  const rows = () => gates.map((gate, index) => ({ planet: PLANETS[index][0], gate, line: index % 6 + 1 }));
  return { personality: [...integrationGates, 29], design: [...integrationGates, 29], activations: { personality: rows(), design: rows() } };
}

test('repeated numeric copies follow gate commitments while inferred and hovered routes add no pressed targets', () => {
  const chart = numericFixture();
  for (const pair of integrationPairs) {
    const [first, second] = pair.gates;
    for (const hovering of [false, true]) {
      const markup = hovering ? render(chart, [gate(first)], gate(second)) : render(chart, pair.gates.map(gate));
      const rows = targets(markup).filter(target => target.type === 'gate' && target.activation);
      assert.equal(rows.length, 18);
      for (const id of pair.gates) assert.equal(rows.filter(target => Number(target.id) === id).length, 4);
      for (const row of rows) {
        const highlighted = pair.gates.includes(Number(row.id));
        const pressed = Number(row.id) === first || !hovering && Number(row.id) === second;
        assert.equal(attribute(row.tag, 'data-selected'), String(highlighted), `${row.activation}: both selected endpoint numbers are highlighted`);
        assert.equal(attribute(row.tag, 'aria-pressed'), String(pressed), `${row.activation}: hover does not commit duplicate numeric copies`);
      }
      assert.deepEqual(graphPressed(markup), new Set((hovering ? [first] : pair.gates).map(id => `gate:${id}`)));
      assert.deepEqual(integrationOutline(markup), integrationOutline(render(chart, [channel(pair.id)])));
    }
  }
});

test('channel-scope endpoints do not infer connections with independent gates or centers', () => {
  const chart = chartStates.find(([state]) => state === 'black')[1];
  const combinations = [
    [channel('10-20'), gate(57)],
    [channel('34-57'), gate(20)],
    [channel('10-20'), center('spleen')],
    [channel('34-57'), center('throat')],
  ];
  for (const selections of combinations.flatMap(items => [items, [...items].reverse()])) {
    const markup = render(chart, selections), outline = integrationOutline(markup);
    assert.equal(pathParts(outline.path).includes(stemPath), false, 'endpoints supplied only by a selected channel do not complete a new crossing route');
    assert.doesNotMatch(outline.mask, /class="bg-integration-owned-stem"/);
    assert.deepEqual(graphPressed(markup), new Set(selections.map(item => `${item.type}:${item.id}`)));
  }
  for (const selections of [
    [center('throat'), gate(20), gate(57)],
    [channel('10-20'), gate(20), gate(57)],
    [channel('10-20'), center('throat'), gate(57)],
  ]) {
    assert.equal(pathParts(integrationOutline(render(chart, selections)).path).includes(stemPath), true, 'independent gate or center scopes complete their route when channel scopes overlap');
  }
  const preview = render(chart, [channel('10-20')], center('spleen'));
  assert.equal(pathParts(integrationOutline(preview).path).includes(stemPath), false, 'hovering a center does not make channel-scope endpoints independent');
  assert.deepEqual(graphPressed(preview), new Set(['channel:10-20']));
});

test('ordinary channels keep their separate endpoint halves without inferring full channel selections', () => {
  const chart = numericFixture();
  for (const pair of CHANNELS.filter(item => !INTEGRATION_IDS.has(item.id))) {
    const markup = render(chart, pair.gates.map(gate));
    const target = targets(markup).find(item => item.type === 'channel' && item.id === pair.id);
    assert.ok(target);
    assert.match(target.content, /class="bg-channel-highlight"[^>]*opacity="0"/);
    assert.deepEqual(new Set([...target.content.matchAll(/data-highlight-gate="(\d+)"/g)].map(([, id]) => Number(id))), new Set(pair.gates));
    assert.deepEqual(graphPressed(markup), new Set(pair.gates.map(id => `gate:${id}`)));
  }
});

function freezeDeep(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freezeDeep);
    Object.freeze(value);
  }
  return value;
}

test('inferred pair outlines leave frozen inputs, numeric content, source paint and geometry unchanged', () => {
  const chart = freezeDeep(numericFixture());
  const selections = freezeDeep([gate(20), gate(57)]), preview = freezeDeep(gate(10));
  const before = JSON.stringify({ chart, selections, preview }), baseline = render(chart, []);
  for (const temporary of [null, preview]) {
    const markup = render(chart, selections, temporary);
    assert.deepEqual(permanentArtwork(markup), permanentArtwork(baseline));
    const texts = value => [...value.matchAll(/<text\b[^>]*>[\s\S]*?<\/text>/g)].map(match => match[0]);
    assert.deepEqual(texts(markup), texts(baseline), 'line numbers, symbols and fixing labels do not change');
  }
  assert.equal(JSON.stringify({ chart, selections, preview }), before);
});

function connectedLayers(mask) {
  const find = name => mask.match(new RegExp(`<path class="bg-integration-${name}"[^>]*\\/>`))?.[0];
  return {
    fullInterior: find('interior'), footprint: find('connected-footprint'),
    interior: find('connected-interior'), occlusion: find('connected-occlusion'),
  };
}

test('paired and explicit routes preserve same-fork cuts and restore continuous cross-stem outlines', () => {
  const chart = { personality: [], design: [] };
  for (const pair of integrationPairs) {
    for (const selections of [pair.gates.map(gate), [channel(pair.id)]]) {
      const outline = integrationOutline(render(chart, selections));
      const { fullInterior, footprint, interior, occlusion } = connectedLayers(outline.mask);
      assert.ok(fullInterior, 'base ownership still subtracts the complete physical node');
      if (!pathParts(outline.path).includes(stemPath)) {
        assert.equal(footprint, undefined, `${pair.id}: no rounded footprint may bypass the physical terminal cuts`);
        assert.equal(interior, undefined);
        assert.equal(occlusion, undefined);
        assert.equal((outline.mask.match(/class="bg-integration-owned-arm"/g) || []).length, 2);
        assert.doesNotMatch(outline.mask, /class="bg-integration-owned-stem"/);
        assert.ok(outline.mask.endsWith(fullInterior + '</mask>'));
        continue;
      }
      assert.ok(footprint, `${pair.id}: complete routes regain their continuous outer footprint`);
      assert.ok(interior, `${pair.id}: the route interior is subtracted again to leave only its outline`);
      assert.equal(occlusion, undefined, 'inactive unselected branches do not interrupt the connected outline');
      assert.ok(outline.mask.lastIndexOf('class="bg-integration-owned-') < outline.mask.indexOf(fullInterior));
      assert.ok(outline.mask.indexOf(fullInterior) < outline.mask.indexOf(footprint));
      assert.ok(outline.mask.indexOf(footprint) < outline.mask.indexOf(interior));
      assert.deepEqual(new Set(pathParts(attribute(footprint, 'd'))), new Set(pathParts(outline.path)), 'the repaint follows only the complete selected route');
      assert.equal(attribute(interior, 'd'), attribute(footprint, 'd'));
      for (const [element, stroke, width] of [[footprint, '#ffffff', '13.2'], [interior, '#000000', '8.448']]) {
        assert.equal(attribute(element, 'fill'), 'none');
        assert.equal(attribute(element, 'stroke'), stroke);
        assert.equal(attribute(element, 'stroke-width'), width);
        assert.equal(attribute(element, 'stroke-linecap'), 'round');
        assert.equal(attribute(element, 'stroke-linejoin'), 'round');
        assert.equal(attribute(element, 'clip-path'), undefined, 'connected route restoration is not cut by a terminal ownership clip');
      }
    }
  }
});

test('connected masks protect only active unselected physical arms and an active unselected stem', () => {
  const states = [
    ...chartStates,
    ['upper-only', { personality: [10], design: [] }],
    ['lower-only', { personality: [], design: [34] }],
    ['one-per-side', { personality: [10], design: [57] }],
  ];
  for (const pair of integrationPairs) {
    const includesStem = [10, 20].includes(pair.gates[0]) !== [10, 20].includes(pair.gates[1]);
    for (const [state, chart] of states) {
      const active = new Set([...chart.personality, ...chart.design]);
      const expectedParts = INTEGRATION_ARMS.filter(arm => active.has(arm.gate) && !pair.gates.includes(arm.gate)).map(arm => arm.path);
      const activeStem = [10, 20].some(id => active.has(id)) && [34, 57].some(id => active.has(id));
      if (activeStem && !includesStem) expectedParts.push(stemPath);
      const outline = integrationOutline(render(chart, pair.gates.map(gate)));
      const { fullInterior, footprint, interior, occlusion } = connectedLayers(outline.mask);
      if (!includesStem) {
        assert.equal(footprint, undefined);
        assert.equal(interior, undefined);
        assert.equal(occlusion, undefined);
        assert.ok(outline.mask.endsWith(fullInterior + '</mask>'), `${pair.id}, ${state}: the full physical cutout protects every neighboring branch`);
        assert.deepEqual(outline, integrationOutline(render(chart, [channel(pair.id)])));
        continue;
      }
      assert.ok(interior);
      if (!expectedParts.length) {
        assert.equal(occlusion, undefined, `${pair.id}, ${state}: no active unselected geometry requires protection`);
        continue;
      }
      assert.ok(occlusion, `${pair.id}, ${state}: active neighboring paint remains protected`);
      assert.deepEqual(new Set(pathParts(attribute(occlusion, 'd'))), new Set(expectedParts));
      assert.ok(outline.mask.indexOf(occlusion) > outline.mask.indexOf(interior), 'neighbor protection is applied after the connected route layers');
      assert.equal(attribute(occlusion, 'fill'), 'none');
      assert.equal(attribute(occlusion, 'stroke'), '#000000');
      assert.equal(attribute(occlusion, 'stroke-width'), '8.448');
      assert.equal(attribute(occlusion, 'stroke-linecap'), 'round');
      assert.equal(attribute(occlusion, 'stroke-linejoin'), 'round');
      assert.deepEqual(outline, integrationOutline(render(chart, [channel(pair.id)])), 'gate-pair and explicit-channel masks protect the same active neighbors');
    }
  }
});

test('single arms, single-center scopes and complete integration retain their original mask ownership', () => {
  const chart = chartStates.find(([state]) => state === 'dual')[1];
  for (const selections of [
    ...integrationGates.map(id => [gate(id)]),
    ...Object.values(centerForGate).map(id => [center(id)]),
  ]) {
    const { mask } = integrationOutline(render(chart, selections));
    assert.doesNotMatch(mask, /class="bg-integration-connected-/);
    assert.match(mask, /class="bg-integration-owned-arm"/);
    assert.match(mask, /class="bg-integration-interior"/);
  }
  for (const selections of [integrationGates.map(gate), [{ type: 'integration', id: 'integration' }]]) {
    const { mask } = integrationOutline(render(chart, selections));
    assert.match(mask, /<rect[^>]*fill="#ffffff"/);
    assert.doesNotMatch(mask, /class="bg-integration-(?:connected-|owned-)/);
    assert.equal((mask.match(/<path\b/g) || []).length, 1, 'the full-node mask still subtracts the physical interior once');
  }
});

test('hover adds connected route mask layers temporarily and preserves active-neighbor protection', () => {
  const chart = { personality: [10], design: [34] };
  const selections = [gate(20)], baseline = integrationOutline(render(chart, selections));
  assert.doesNotMatch(baseline.mask, /class="bg-integration-connected-/);
  const hovered = render(chart, selections, gate(57));
  const connected = integrationOutline(hovered);
  assert.deepEqual(connected, integrationOutline(render(chart, [channel('20-57')])));
  assert.ok(connectedLayers(connected.mask).footprint);
  assert.ok(connectedLayers(connected.mask).occlusion);
  assert.deepEqual(graphPressed(hovered), new Set(['gate:20']));
  assert.deepEqual(integrationOutline(render(chart, selections, null)), baseline, 'leaving restores the single arm mask without connected layers');
});

function centerPairSelections([left, right]) {
  const combinations = [
    [center(centerForGate[left]), gate(right)],
    [gate(left), center(centerForGate[right])],
    [center(centerForGate[left]), center(centerForGate[right])],
  ];
  return combinations.flatMap(items => [items, [...items].reverse()]);
}

for (const pair of integrationPairs) {
  test(`center-owned integration endpoints complete ${pair.id} with gates or centers in either order`, () => {
    for (const [state, chart] of chartStates) {
      const expected = integrationOutline(render(chart, [channel(pair.id)]));
      const baseline = permanentArtwork(render(chart, []));
      for (const selections of centerPairSelections(pair.gates)) {
        const markup = render(chart, selections);
        assert.deepEqual(integrationOutline(markup), expected, `${state}: center-owned endpoints use the exact channel path and mask`);
        assert.deepEqual(graphPressed(markup), new Set(selections.map(item => `${item.type}:${item.id}`)), 'the inferred connection adds no pressed gate, channel or integration targets');
        assert.deepEqual(permanentArtwork(markup), baseline, 'ordinary center highlighting leaves physical geometry and source paint intact');
        for (const remaining of selections) {
          const restored = render(chart, [remaining]), outline = integrationOutline(restored);
          assert.equal(pathParts(outline.path).length, 1, 'removing either scope restores its surviving integration arm');
          assert.equal(pathParts(outline.path).includes(stemPath), false);
          assert.doesNotMatch(outline.mask, /class="bg-integration-connected-/);
          assert.deepEqual(graphPressed(restored), new Set([`${remaining.type}:${remaining.id}`]));
        }
      }
    }
  });
}

function centerNumericFixture() {
  // Repeated integration copies plus an ordinary gate owned by each involved
  // center make the full numeric scope visible in both source columns.
  const gates = [20, 20, 57, 57, 10, 10, 34, 34, 1, 16, 29, 48, 54];
  const rows = () => gates.map((gate, index) => ({ planet: PLANETS[index][0], gate, line: index % 6 + 1 }));
  return { personality: [...new Set(gates)], design: [...new Set(gates)], activations: { personality: rows(), design: rows() } };
}

function assertNumericScopes(markup, committed, preview = null) {
  const gatesFor = items => new Set(items.filter(Boolean).flatMap(item => item.type === 'gate' ? [Number(item.id)]
    : item.type === 'center' ? GATES.filter(gate => gate.center === item.id).map(gate => gate.id) : []));
  const pressed = gatesFor(committed), highlighted = gatesFor([...committed, preview]);
  const rows = targets(markup).filter(target => target.type === 'gate' && target.activation);
  assert.equal(rows.length, 26);
  for (const row of rows) {
    assert.equal(attribute(row.tag, 'data-selected'), String(highlighted.has(Number(row.id))), `${row.activation} follows its complete gate or center highlight scope`);
    assert.equal(attribute(row.tag, 'aria-pressed'), String(pressed.has(Number(row.id))), `${row.activation} follows only committed gate or center scopes`);
  }
}

test('center-owned connections preserve all center numeric copies without promoting their diagram gates', () => {
  const chart = freezeDeep(centerNumericFixture()), before = JSON.stringify(chart);
  for (const pair of integrationPairs) {
    for (const selections of centerPairSelections(pair.gates)) {
      const markup = render(chart, selections);
      assertNumericScopes(markup, selections);
      assert.deepEqual(graphPressed(markup), new Set(selections.map(item => `${item.type}:${item.id}`)));
      for (const remaining of selections) assertNumericScopes(render(chart, [remaining]), [remaining]);
    }
  }
  assert.equal(JSON.stringify(chart), before);
});

test('hovering a center or corresponding gate completes every integration pair temporarily and leave restores its original scope', () => {
  const chart = freezeDeep(centerNumericFixture());
  for (const pair of integrationPairs) {
    const expected = integrationOutline(render(chart, [channel(pair.id)]));
    for (const [left, right] of [pair.gates, [...pair.gates].reverse()]) {
      for (const [committed, preview] of [
        [center(centerForGate[left]), gate(right)],
        [gate(left), center(centerForGate[right])],
        [center(centerForGate[left]), center(centerForGate[right])],
      ]) {
        const selections = freezeDeep([committed]), hover = freezeDeep(preview);
        const before = JSON.stringify({ selections, hover });
        const baseline = render(chart, selections), markup = render(chart, selections, hover);
        assert.deepEqual(integrationOutline(markup), expected);
        assert.deepEqual(allPressed(markup), allPressed(baseline), 'temporary center-owned completion does not promote any diagram or numeric target');
        assert.deepEqual(graphPressed(markup), new Set([`${committed.type}:${committed.id}`]));
        assertNumericScopes(markup, selections, hover);
        assert.equal(render(chart, selections, null), baseline, 'leaving restores every original gate, center and numeric highlight');
        assert.equal(pathParts(integrationOutline(baseline).path).length, 1);
        assert.doesNotMatch(integrationOutline(baseline).mask, /class="bg-integration-connected-/);
        assert.equal(JSON.stringify({ selections, hover }), before);
      }
    }
  }
});
