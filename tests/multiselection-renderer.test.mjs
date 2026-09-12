import test from 'node:test';
import assert from 'node:assert/strict';
import { renderBodygraph } from '../src/bodygraph/bodygraph.js';
import { CENTERS, GATES, CHANNELS } from '../src/bodygraph/graph-data.js';
import { STEM_POINTS } from '../src/bodygraph/integration-geometry.js';

const chartFixture = () => ({
  personality: [1, 10, 20, 29, 34, 37, 41, 52, 53, 54, 57, 60],
  design: [1, 19, 20, 29, 40, 41, 52, 54, 57],
  activations: {
    personality: [
      { planet: 'sun', gate: 20, line: 1 }, { planet: 'earth', gate: 20, line: 2 },
      { planet: 'moon', gate: 29, line: 3 }, { planet: 'mercury', gate: 41, line: 4 },
      { planet: 'venus', gate: 37, line: 5 }, { planet: 'mars', gate: 54, line: 6 },
    ],
    design: [
      { planet: 'sun', gate: 20, line: 3 }, { planet: 'earth', gate: 20, line: 4 },
      { planet: 'moon', gate: 29, line: 5 }, { planet: 'mercury', gate: 41, line: 6 },
      { planet: 'venus', gate: 40, line: 1 }, { planet: 'mars', gate: 52, line: 2 },
    ],
  },
});

const gate = id => ({ type: 'gate', id });
const center = id => ({ type: 'center', id });
const channel = id => ({ type: 'channel', id });
const planet = id => ({ type: 'planet', id });
const render = (chart, selections, previewSelection = null) => renderBodygraph(chart, null, { selections, previewSelection, showActivations: true });
const attribute = (tag, name) => tag.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1];

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
const numericCopies = markup => targets(markup).filter(target => target.type === 'gate' && target.activation);

function visibleHighlights(markup) {
  const groups = targets(markup), graph = groups.filter(target => !target.activation);
  const integrationPath = markup.match(/<path class="bg-integration-selection" d="([^"]+)"/)?.[1] || '';
  return {
    gates: new Set(graph.filter(target => target.type === 'gate' && attribute(target.tag, 'data-related') === 'true').map(target => target.id)),
    centers: new Set(graph.filter(target => target.type === 'center' && /<path class="bg-center-highlight"[^>]*opacity="1"/.test(target.content)).map(target => target.id)),
    channels: new Set(graph.filter(target => target.type === 'channel' && /<path class="bg-channel-highlight"[^>]*opacity="1"/.test(target.content)).map(target => target.id)),
    relatedChannels: new Set(graph.filter(target => target.type === 'channel' && attribute(target.tag, 'data-related') === 'true').map(target => target.id)),
    halfPaths: new Set(graph.filter(target => target.type === 'channel').flatMap(target => [...target.content.matchAll(/<g data-highlight-gate="(\d+)">(<path[^>]*\/>)/g)].map(([, id, path]) => `${target.id}:${id}:${path}`))),
    integrationPaths: new Set(integrationPath.split(/(?=M)/).map(path => path.trim()).filter(Boolean)),
    numericCopies: new Set(numericCopies(markup).filter(target => attribute(target.tag, 'data-selected') === 'true').map(target => target.activation)),
    planets: new Set(groups.filter(target => target.type === 'planet' && /<rect[^>]*fill="#eaf0f8"/.test(target.content)).map(target => target.id)),
  };
}

function assertVisualUnion(chart, selections, previewSelection = null) {
  const markup = render(chart, selections, previewSelection);
  const visualSelections = [...selections, previewSelection].filter(Boolean);
  const parts = visualSelections
    .map(selection => visibleHighlights(renderBodygraph(chart, selection, { showActivations: true })));
  const actual = visibleHighlights(markup);
  const wholeChannels = new Set(parts.flatMap(part => [...part.channels]));
  const individualGates = new Set(visualSelections.filter(item => item.type === 'gate').map(item => Number(item.id)));
  const completeCenters = CENTERS.filter(item => GATES.filter(candidate => candidate.center === item.id).every(candidate => individualGates.has(candidate.id)));
  const ownedGates = new Set(visualSelections.flatMap(item => item.type === 'gate' ? [Number(item.id)]
    : item.type === 'center' ? GATES.filter(gate => gate.center === item.id).map(gate => gate.id) : []));
  const connectsIntegrationStem = [10, 20].some(id => ownedGates.has(id)) && [34, 57].some(id => ownedGates.has(id));
  for (const key of Object.keys(actual)) {
    const combined = parts.flatMap(part => [...part[key]]);
    // A full channel supplies its own complete halo, including either endpoint.
    const expected = new Set(key === 'halfPaths' ? combined.filter(path => !wholeChannels.has(path.split(':')[0])) : combined);
    // Completing individual gate selections also supplies the center's outline.
    // This visual consequence does not add a committed center selection.
    if (key === 'centers') completeCenters.forEach(item => expected.add(item.id));
    // Individual gates and center-owned gates can complete integration routes.
    // Endpoints highlighted only through a selected channel do not do so.
    if (key === 'integrationPaths' && connectsIntegrationStem) expected.add(stemPath);
    assert.deepEqual(actual[key], expected, `${key} preserves the union of independent selection scopes`);
  }
  return markup;
}

test('an omitted selections array preserves legacy selection rendering', () => {
  const chart = chartFixture();
  for (const selected of [null, gate(20), center('throat'), channel('37-40'), planet('design-sun')]) {
    const legacy = renderBodygraph(chart, selected, { showActivations: true });
    assert.equal(renderBodygraph(chart, selected, { selections: undefined, showActivations: true }), legacy);
    assert.equal(render(chart, selected ? [selected] : []), legacy, 'one committed item keeps its existing appearance and pressed state');
  }
});

test('an explicit empty array clears legacy selection and hover remains temporary', () => {
  const chart = chartFixture(), legacy = center('throat');
  assert.equal(renderBodygraph(chart, legacy, { selections: [], showActivations: true }), render(chart, []));
  const hovered = renderBodygraph(chart, legacy, { selections: [], previewSelection: gate(29), showActivations: true });
  assert.deepEqual(visibleHighlights(hovered), visibleHighlights(render(chart, [gate(29)])));
  assert.deepEqual(allPressed(hovered), new Set());
  assert.deepEqual(visibleHighlights(hovered).centers, new Set(), 'the overridden legacy center contributes no highlight');
});

test('committed gates 54, 52, 53 and 60 accumulate and removing any item preserves the others', () => {
  const chart = chartFixture(), selections = [54, 52, 53, 60].map(gate);
  for (let count = 1; count <= selections.length; count++) {
    const subset = selections.slice(0, count), markup = assertVisualUnion(chart, subset);
    assert.deepEqual(graphPressed(markup), new Set(subset.map(item => `gate:${item.id}`)));
    assert.deepEqual(visibleHighlights(markup).gates, new Set(subset.map(item => String(item.id))));
  }
  for (const removed of selections) {
    const remaining = selections.filter(item => item !== removed), markup = assertVisualUnion(chart, remaining);
    assert.deepEqual(graphPressed(markup), new Set(remaining.map(item => `gate:${item.id}`)));
    assert.equal(visibleHighlights(markup).gates.has(String(removed.id)), false, `gate ${removed.id} is independently removed`);
  }
});

test('the renderer honors explicit center-plus-gate arrays without applying app gesture normalization', () => {
  // This is a direct renderer contract. The app handles Shift on an own gate
  // by replacing its center item with the remaining individual gate items.
  const chart = chartFixture(), throat = center('throat');
  for (const id of [20, 29]) {
    const markup = assertVisualUnion(chart, [throat, gate(id)]);
    assert.deepEqual(graphPressed(markup), new Set(['center:throat', `gate:${id}`]), 'related center gates are highlighted without becoming independent pressed targets');
    const centerGates = GATES.filter(item => item.center === 'throat').map(item => String(item.id));
    assert.deepEqual(visibleHighlights(markup).gates, new Set([...centerGates, String(id)]));
    assert.deepEqual(graphPressed(render(chart, [throat])), new Set(['center:throat']), 'removing the explicit gate leaves only the center committed');
    assert.deepEqual(graphPressed(render(chart, [gate(id)])), new Set([`gate:${id}`]), 'removing the center retains the explicit gate');
    assert.deepEqual(visibleHighlights(render(chart, [gate(id)])).centers, new Set());
  }
});

test('a channel and an independent gate preserve their scopes without pressing related endpoints', () => {
  const chart = chartFixture();
  for (const id of [37, 29]) {
    const markup = assertVisualUnion(chart, [channel('37-40'), gate(id)]);
    assert.deepEqual(graphPressed(markup), new Set(['channel:37-40', `gate:${id}`]));
    assert.deepEqual(visibleHighlights(markup).gates, new Set(['37', '40', String(id)]));
    assert.deepEqual(visibleHighlights(render(chart, [gate(id)])).channels, new Set(), 'removing the channel does not retain a full-channel halo');
    assert.deepEqual(graphPressed(render(chart, [channel('37-40')])), new Set(['channel:37-40']));
  }
});

test('multiple centers and planet symbols retain separate committed highlights', () => {
  const chart = chartFixture();
  const selections = [center('throat'), center('sacral'), planet('design-sun'), planet('personality-earth')];
  const markup = assertVisualUnion(chart, selections);
  assert.deepEqual(graphPressed(markup), new Set(['center:throat', 'center:sacral']));
  assert.deepEqual(visibleHighlights(markup).planets, new Set(['design-sun', 'personality-earth']));
  for (const target of targets(markup).filter(target => target.type === 'planet')) {
    assert.equal(attribute(target.tag, 'aria-pressed'), String(['design-sun', 'personality-earth'].includes(target.id)), `${target.id} has its own pressed state`);
  }
  const remaining = selections.filter(item => item.id !== 'design-sun');
  assert.deepEqual(visibleHighlights(assertVisualUnion(chart, remaining)).planets, new Set(['personality-earth']));
});

test('all repeated numeric copies follow the union of committed gate scopes across both sources', () => {
  const chart = chartFixture();
  const gate20 = { ...gate(20), activation: 'design-sun' };
  const selections = [gate20, { ...gate(29), activation: 'personality-moon' }];
  const markup = assertVisualUnion(chart, selections);
  const copies = numericCopies(markup);
  assert.equal(copies.filter(target => target.id === '20').length, 4);
  for (const target of copies) {
    const selected = ['20', '29'].includes(target.id);
    assert.equal(attribute(target.tag, 'data-selected'), String(selected), `${target.activation} shares the gate highlight`);
    assert.equal(attribute(target.tag, 'aria-pressed'), String(selected), `${target.activation} shares the committed gate state`);
  }
  const remaining = render(chart, selections.slice(1));
  assert.ok(numericCopies(remaining).filter(target => target.id === '20').every(target => attribute(target.tag, 'aria-pressed') === 'false'));
  assert.ok(numericCopies(remaining).filter(target => target.id === '29').every(target => attribute(target.tag, 'aria-pressed') === 'true'));
  assert.equal(render(chart, [{ ...gate20, activation: 'personality-earth' }, selections[1]]), markup, 'choosing another copy retains the same graph paint');
});

test('hover adds to all committed highlights without broadening any pressed state', () => {
  const chart = chartFixture(), selections = [center('throat'), gate(29), channel('37-40'), planet('design-sun')];
  const baseline = render(chart, selections), pressed = allPressed(baseline);
  for (const preview of [gate(1), gate(20), gate(29), center('root'), channel('3-60'), { type: 'integration', id: 'integration' }]) {
    const markup = assertVisualUnion(chart, selections, preview);
    assert.deepEqual(allPressed(markup), pressed, `${preview.type} ${preview.id} does not become committed`);
  }
  assert.equal(render(chart, selections), baseline, 'ending hover restores the complete committed display');
});

const stemPath = STEM_POINTS.map(([x, y], index) => `${index ? 'L' : 'M'}${x.toFixed(2)},${y.toFixed(2)}`).join(' ');

test('flattened throat minus gate 20 preserves remaining gate halves and unrelated committed selections', () => {
  const chart = freezeDeep(chartFixture());
  const unrelated = freezeDeep([gate(29), gate(57), channel('37-40'), planet('design-sun')]);
  const remainingThroat = GATES.filter(item => item.center === 'throat' && item.id !== 20).map(item => gate(item.id));
  const flattened = freezeDeep([...remainingThroat, ...unrelated]);
  const before = JSON.stringify({ chart, unrelated, flattened });
  const original = assertVisualUnion(chart, [center('throat'), ...unrelated]);
  const markup = assertVisualUnion(chart, flattened), highlights = visibleHighlights(markup);
  const expectedGates = visibleHighlights(original).gates;
  expectedGates.delete('20');
  assert.deepEqual(highlights.gates, expectedGates, 'only the removed throat gate loses its highlight');
  assert.deepEqual(highlights.centers, new Set(), 'the missing gate prevents automatic throat outline');
  assert.deepEqual(highlights.halfPaths, visibleHighlights(original).halfPaths, 'all ordinary throat and unrelated channel halves remain');
  assert.deepEqual(highlights.channels, new Set(['37-40']));
  assert.deepEqual(highlights.planets, new Set(['design-sun']));
  assert.deepEqual(graphPressed(markup), new Set(flattened.filter(item => item.type !== 'planet').map(item => `${item.type}:${item.id}`)), 'remaining gates are individual committed items and the center is gone');
  assert.deepEqual(highlights.integrationPaths, visibleHighlights(render(chart, [gate(57)])).integrationPaths, 'only the unrelated gate 57 arm remains');
  assert.match(markup, /class="bg-integration-arm" data-arm="20" data-related="false"/);
  assert.match(markup, /class="bg-integration-arm" data-arm="57" data-related="true"/);
  assert.equal(highlights.integrationPaths.has(stemPath), false, 'removing gate 20 does not invent a shared stem');
  const mask = markup.match(/<mask id="bodygraph-integration-selection-outline"[^>]*>([\s\S]*?)<\/mask>/)?.[1];
  assert.ok(mask);
  assert.doesNotMatch(mask, /class="bg-integration-owned-stem"/);
  const copies20 = numericCopies(markup).filter(item => item.id === '20');
  assert.equal(copies20.length, 4);
  assert.ok(copies20.every(item => attribute(item.tag, 'data-selected') === 'false' && attribute(item.tag, 'aria-pressed') === 'false'), 'all numeric copies of the removed gate are unselected');
  assert.ok(allPressed(markup).has('design-sun-planet'), 'the unrelated planet remains committed even though its gate number is removed');
  assert.deepEqual(permanentArtwork(markup), permanentArtwork(original), 'flattening changes selection paint without changing chart geometry or activation colors');
  assert.equal(JSON.stringify({ chart, unrelated, flattened }), before);
});

test('selected channel endpoints cannot infer another integration connection with a gate or center', () => {
  const chart = chartFixture();
  for (const selections of [[channel('10-20'), gate(57)], [channel('10-20'), center('spleen')], [center('throat'), channel('34-57')], [gate(20), channel('34-57')]]) {
    const markup = assertVisualUnion(chart, selections);
    assert.equal(visibleHighlights(markup).integrationPaths.has(stemPath), false);
    const mask = markup.match(/<mask id="bodygraph-integration-selection-outline"[^>]*>([\s\S]*?)<\/mask>/)?.[1];
    assert.ok(mask, 'partial integration highlights retain an ownership mask');
    assert.doesNotMatch(mask, /class="bg-integration-owned-stem"/);
    assert.equal(graphPressed(markup).has('channel:20-57'), false);
    assert.equal(graphPressed(markup).has('integration:integration'), false);
  }
});

test('individual gate 20 and an atomic sacral center complete integration without changing their selected scopes', () => {
  const chart = chartFixture();
  for (const selections of [[gate(20), center('sacral')], [center('sacral'), gate(20)], [center('throat'), center('sacral')]]) {
    const markup = assertVisualUnion(chart, selections);
    assert.deepEqual(visibleHighlights(markup).integrationPaths, visibleHighlights(render(chart, [channel('20-34')])).integrationPaths);
    assert.deepEqual(graphPressed(markup), new Set(selections.map(item => `${item.type}:${item.id}`)));
    assert.equal(visibleHighlights(markup).centers.has('sacral'), true);
    for (const gate of GATES.filter(item => item.center === 'sacral')) assert.equal(visibleHighlights(markup).gates.has(String(gate.id)), true);
  }
});

test('two individually selected integration gates connect while remaining the only committed targets', () => {
  const chart = chartFixture(), selections = [gate(20), gate(57)];
  const markup = assertVisualUnion(chart, selections);
  assert.deepEqual(visibleHighlights(markup).integrationPaths, visibleHighlights(render(chart, [channel('20-57')])).integrationPaths);
  assert.equal(visibleHighlights(markup).integrationPaths.has(stemPath), true);
  assert.match(markup.match(/<mask id="bodygraph-integration-selection-outline"[^>]*>([\s\S]*?)<\/mask>/)?.[1] || '', /class="bg-integration-owned-stem"/);
  assert.deepEqual(graphPressed(markup), new Set(['gate:20', 'gate:57']));
});

test('explicit crossing channels and whole integration contribute the common stem once', () => {
  const chart = chartFixture();
  for (const selections of [
    [channel('20-57'), gate(10)],
    [channel('20-57'), channel('10-34')],
    [gate(20), gate(57), channel('20-57')],
    [{ type: 'integration', id: 'integration' }, gate(29)],
  ]) {
    const markup = assertVisualUnion(chart, selections);
    const path = markup.match(/<path class="bg-integration-selection" d="([^"]+)"/)?.[1];
    assert.ok(path);
    const paths = path.split(/(?=M)/).map(item => item.trim()).filter(Boolean);
    assert.equal(paths.filter(item => item === stemPath).length, 1);
    assert.equal(paths.length, new Set(paths).size, 'shared branches and stem are not duplicated');
    assert.deepEqual(graphPressed(markup), new Set(selections.map(item => `${item.type}:${item.id}`)));
  }
});

function permanentArtwork(markup) {
  const groups = targets(markup);
  return {
    shapes: [...markup.matchAll(/<(?:path|circle)\b[^>]*class="bg-(?:channel-outline|center-shape|gate-disc)"[^>]*\/>/g)].map(match => match[0]),
    sourcePaths: [...markup.matchAll(/<path\b[^>]*stroke="(?:#202020|#c32d35)"[^>]*\/>/g)].map(match => match[0]),
    columnPaint: [...markup.matchAll(/<g class="activation-column"[^>]*>/g)].map(match => match[0]),
    positions: [...markup.matchAll(/<g\b[^>]*transform="[^"]+"[^>]*>/g)].map(match => attribute(match[0], 'transform')),
    targets: groups.map(target => [target.type, target.id, target.activation, attribute(target.tag, 'tabindex'), attribute(target.tag, 'role'), attribute(target.tag, 'aria-label')]),
    hitShapes: [...markup.matchAll(/<(?:path|circle)\b[^>]*pointer-events="(?:all|stroke)"[^>]*\/>/g)].map(match => match[0]),
  };
}

function freezeDeep(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freezeDeep);
    Object.freeze(value);
  }
  return value;
}

test('multiselection preserves input data, geometry, source paint and interaction targets', () => {
  const chart = freezeDeep(chartFixture());
  const selections = freezeDeep([gate(54), gate(52), center('throat'), channel('37-40'), planet('design-sun')]);
  const preview = freezeDeep(gate(57)), before = JSON.stringify({ chart, selections, preview });
  const baseline = permanentArtwork(render(chart, []));
  for (const temporary of [null, preview]) {
    const markup = render(chart, selections, temporary);
    assert.deepEqual(permanentArtwork(markup), baseline, 'only selection paint and pressed state change');
  }
  assert.equal(JSON.stringify({ chart, selections, preview }), before);
});

for (const targetCenter of CENTERS) {
  test(`all individual ${targetCenter.id} gates outline the center, and removing any gate removes that outline`, () => {
    const chart = freezeDeep(chartFixture());
    const selections = freezeDeep(GATES.filter(item => item.center === targetCenter.id).map(item => gate(item.id)));
    const before = JSON.stringify({ chart, selections });
    const complete = assertVisualUnion(chart, selections);
    const highlights = visibleHighlights(complete);
    assert.deepEqual(highlights.centers, new Set([targetCenter.id]));
    assert.deepEqual(highlights.gates, new Set(selections.map(item => String(item.id))), 'automatic center outline adds no unrelated gate');
    assert.deepEqual(highlights.channels, new Set(), 'individual gates do not select whole channels');
    assert.deepEqual(graphPressed(complete), new Set(selections.map(item => `gate:${item.id}`)), 'the outlined center is not promoted to a committed item');
    const selectedIds = new Set(selections.map(item => String(item.id)));
    for (const half of highlights.halfPaths) assert.ok(selectedIds.has(half.split(':')[1]), 'no opposite channel half is highlighted');

    for (const removed of selections) {
      const remaining = Object.freeze(selections.filter(item => item !== removed));
      const incomplete = assertVisualUnion(chart, remaining);
      assert.deepEqual(visibleHighlights(incomplete).centers, new Set(), `missing gate ${removed.id} prevents automatic completion`);
      assert.deepEqual(visibleHighlights(incomplete).gates, new Set(remaining.map(item => String(item.id))), 'removal retains precisely the remaining gates');
      assert.deepEqual(graphPressed(incomplete), new Set(remaining.map(item => `gate:${item.id}`)));
    }
    assert.equal(render(chart, selections), complete, 'restoring the complete gate list restores its outline');
    assert.equal(JSON.stringify({ chart, selections }), before, 'deriving the outline does not modify chart or selection inputs');
  });
}

test('hovering the final gate temporarily completes every center without promoting the gate or center', () => {
  const chart = freezeDeep(chartFixture());
  for (const targetCenter of CENTERS) {
    const gates = GATES.filter(item => item.center === targetCenter.id);
    const selections = freezeDeep(gates.slice(0, -1).map(item => gate(item.id)));
    const preview = freezeDeep(gate(gates.at(-1).id));
    const before = JSON.stringify({ chart, selections, preview });
    const baseline = render(chart, selections), hovered = assertVisualUnion(chart, selections, preview);
    assert.deepEqual(visibleHighlights(baseline).centers, new Set());
    assert.deepEqual(visibleHighlights(hovered).centers, new Set([targetCenter.id]));
    assert.deepEqual(visibleHighlights(hovered).gates, new Set(gates.map(item => String(item.id))));
    assert.deepEqual(allPressed(hovered), allPressed(baseline), 'hover adds no committed diagram or numeric-copy targets');
    assert.deepEqual(graphPressed(hovered), new Set(selections.map(item => `gate:${item.id}`)));
    assert.equal(render(chart, selections), baseline, 'pointer leave removes the automatic center outline');
    assert.equal(JSON.stringify({ chart, selections, preview }), before, 'temporary completion leaves inputs unchanged');
  }
});

test('channel-related gates do not automatically outline centers, even when every gate is related', () => {
  const chart = chartFixture(), selections = CHANNELS.map(item => channel(item.id));
  const markup = assertVisualUnion(chart, selections), highlights = visibleHighlights(markup);
  assert.deepEqual(highlights.gates, new Set(GATES.map(item => String(item.id))), 'all gates are related through explicit channel selections');
  assert.deepEqual(highlights.centers, new Set(), 'related endpoints cannot substitute for individual gate selections');
  assert.deepEqual(graphPressed(markup), new Set(CHANNELS.map(item => `channel:${item.id}`)));
});

test('explicit selection still outlines and presses each center without creating individual gate selections', () => {
  const chart = chartFixture();
  for (const targetCenter of CENTERS) {
    const markup = assertVisualUnion(chart, [center(targetCenter.id)]);
    assert.deepEqual(visibleHighlights(markup).centers, new Set([targetCenter.id]));
    assert.deepEqual(graphPressed(markup), new Set([`center:${targetCenter.id}`]));
  }
});

test('several automatically outlined centers remain independent when one gate is removed', () => {
  const chart = chartFixture(), selections = freezeDeep(GATES.map(item => gate(item.id)));
  const complete = assertVisualUnion(chart, selections);
  assert.deepEqual(visibleHighlights(complete).centers, new Set(CENTERS.map(item => item.id)));
  assert.deepEqual(graphPressed(complete), new Set(GATES.map(item => `gate:${item.id}`)));
  for (const targetCenter of CENTERS) {
    const removed = GATES.find(item => item.center === targetCenter.id);
    const remaining = selections.filter(item => item.id !== removed.id), markup = render(chart, remaining);
    assert.deepEqual(visibleHighlights(markup).centers, new Set(CENTERS.filter(item => item.id !== targetCenter.id).map(item => item.id)));
    assert.deepEqual(graphPressed(markup), new Set(remaining.map(item => `gate:${item.id}`)));
  }
});
