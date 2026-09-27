import test from 'node:test';
import assert from 'node:assert/strict';
import { renderActivationColumns } from '../src/scene/activation-columns.js';
import { renderBodygraph } from '../src/scene/bodygraph-svg.js';

const chart = {
  personality: [8, 29, 1], design: [8, 29],
  activations: {
    design: [
      { planet: 'sun', gate: 8, line: 2 },
      { planet: 'earth', gate: 8, line: 4 },
      { planet: 'moon', gate: 8, line: 2 },
      { planet: 'mercury', gate: 29, line: 2 },
      { planet: 'venus', gate: 29, line: 5 },
    ],
    personality: [
      { planet: 'sun', gate: 8, line: 2 },
      { planet: 'earth', gate: 8, line: 4 },
      { planet: 'moon', gate: 29, line: 2 },
      { planet: 'mercury', gate: 29, line: 6 },
      { planet: 'venus', gate: 1, line: 2 },
    ],
  },
};
const gate = id => ({ type: 'gate', id });
const designLine2 = { line: 2, source: 'design' };
const gate8Copies = ['design-sun', 'design-earth', 'design-moon', 'personality-sun', 'personality-earth'];
const gate29Copies = ['design-mercury', 'design-venus', 'personality-moon', 'personality-mercury'];
const attribute = (tag, name) => tag.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1];

function numericRows(markup) {
  return [...markup.matchAll(/<g\b[^>]*data-type="gate"[^>]*data-activation="[^"]+"[^>]*>[\s\S]*?<\/g>/g)]
    .map(([content]) => ({
      id: attribute(content, 'data-activation'),
      selected: attribute(content, 'data-selected') === 'true',
      pressed: attribute(content, 'aria-pressed') === 'true',
      painted: /<rect[^>]*fill="#eaf0f8"/.test(content),
    }));
}

function assertRows(markup, selected, pressed = selected) {
  const rows = numericRows(markup);
  assert.equal(rows.length, 10, 'every saved activation stays visible');
  assert.deepEqual(new Set(rows.filter(row => row.selected).map(row => row.id)), new Set(selected));
  assert.deepEqual(new Set(rows.filter(row => row.pressed).map(row => row.id)), new Set(pressed));
  for (const row of rows) assert.equal(row.painted, row.selected, `${row.id} paint follows its row highlight`);
}

const render = (selections, options = {}) => renderBodygraph(chart, null, { selections, showActivations: true, ...options });

test('omitting the activation filter preserves gate-wide selection across both columns', () => {
  const options = { selections: [gate(8)], showActivations: true };
  const baseline = renderBodygraph(chart, null, options);
  assertRows(baseline, gate8Copies);
  assert.equal(renderBodygraph(chart, null, { ...options, activationFilter: undefined }), baseline);
  assert.equal(renderBodygraph(chart, null, { ...options, activationFilter: null }), baseline);
  const hovered = render([gate(8)], { previewSelection: gate(29) });
  assertRows(hovered, [...gate8Copies, ...gate29Copies], gate8Copies);
});

test('design line 2 selects every exact duplicate but excludes another line and the same personality gate', () => {
  const markup = render([gate(8)], { activationFilter: designLine2 });
  assertRows(markup, ['design-sun', 'design-moon']);
  assert.match(markup, /data-type="gate" data-id="8"[^>]*aria-pressed="true"[^>]*data-related="true"/);
});

test('personality line 2 limits numeric highlights to its own source', () => {
  assertRows(render([gate(8), gate(29)], { activationFilter: { line: 2, source: 'personality' } }),
    ['personality-sun', 'personality-moon']);
});

test('all-source line selection matches the line on both sides without adding an unselected gate', () => {
  assertRows(render([gate(8), gate(29)], { activationFilter: { line: 2, source: 'all' } }),
    ['design-sun', 'design-moon', 'design-mercury', 'personality-sun', 'personality-moon']);
  assertRows(render([], { activationFilter: { line: 2, source: 'all' } }), []);
});

test('the activation filter never changes the unique gates or any bodygraph artwork', () => {
  const options = { selections: [gate(8), gate(29)], showActivations: false };
  const baseline = renderBodygraph(chart, null, options);
  for (const source of ['design', 'personality', 'all']) {
    assert.equal(renderBodygraph(chart, null, { ...options, activationFilter: { line: 2, source } }), baseline);
  }
});

test('hover on a different gate unions all its numeric rows while keeping the committed line filter', () => {
  const selections = [gate(8)], options = { activationFilter: designLine2 };
  const baseline = render(selections, options);
  assertRows(render(selections, { ...options, previewSelection: gate(29) }),
    ['design-sun', 'design-moon', ...gate29Copies], ['design-sun', 'design-moon']);
  assert.equal(render(selections, options), baseline, 'ending hover restores the exact filtered selection');
});

test('hover on the committed gate temporarily shows its other lines and source without pressing them', () => {
  assertRows(render([gate(8)], { activationFilter: designLine2, previewSelection: gate(8) }),
    gate8Copies, ['design-sun', 'design-moon']);
});

test('channel and center hover derive preview gates independently of the line filter', () => {
  for (const previewSelection of [{ type: 'channel', id: '1-8' }, { type: 'center', id: 'throat' }]) {
    const previewRows = numericRows(render([], { previewSelection })).filter(row => row.selected).map(row => row.id);
    const committedRows = ['design-mercury'];
    assertRows(render([gate(29)], { activationFilter: designLine2, previewSelection }),
      [...committedRows, ...previewRows], committedRows);
  }
});

test('direct activation rendering supports filter plus a temporary preview without mutating inputs', () => {
  const selectedGates = new Set([8]), previewGates = new Set([29]);
  const options = { activationFilter: Object.freeze({ ...designLine2 }), previewGates };
  const before = JSON.stringify(chart);
  assertRows(renderActivationColumns(chart, selectedGates, null, options),
    ['design-sun', 'design-moon', ...gate29Copies], ['design-sun', 'design-moon']);
  assert.deepEqual([...selectedGates], [8]);
  assert.deepEqual([...previewGates], [29]);
  assert.equal(JSON.stringify(chart), before);
});

test('multiple line groups limit each predicate to its own remaining gates', () => {
  const activationFilter = {
    groups: [
      { line: 2, source: 'design', gates: [8] },
      { line: 6, source: 'personality', gates: [29] },
    ],
    unfilteredGates: [],
  };
  assertRows(render([gate(8), gate(29)], { activationFilter }),
    ['design-sun', 'design-moon', 'personality-mercury']);
  assertRows(render([gate(8), gate(29)], { activationFilter, previewSelection: gate(8) }),
    [...gate8Copies, 'personality-mercury'], ['design-sun', 'design-moon', 'personality-mercury']);
});

test('ordinary unfiltered gates union with exact line groups without broadening other groups', () => {
  const activationFilter = {
    groups: [{ line: 2, source: 'design', gates: [8] }],
    unfilteredGates: [29],
  };
  assertRows(render([gate(8), gate(29)], { activationFilter }),
    ['design-sun', 'design-moon', ...gate29Copies]);
  assertRows(render([gate(8), gate(29)], { activationFilter, previewSelection: gate(8) }),
    [...gate8Copies, ...gate29Copies], ['design-sun', 'design-moon', ...gate29Copies]);
});
