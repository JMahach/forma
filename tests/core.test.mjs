import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseGates, validateChart,
  readCharts, writeCharts, STORAGE_KEY, TRASH_KEY, deleteChart
} from '../src/data/storage.js';
import { zoomAt, validView, fitView } from '../src/scene/camera.js';
import { attachGestures } from './fixtures/gesture-harness.js';
import { DRAWING_BOUNDS } from '../src/scene/geometry/frames.js';
import { CENTERS, GATES, CHANNELS, getGate, getCenter, getChannel } from '../src/scene/geometry/chart-geometry.js';
import { DEMO_CHART } from './fixtures/demo-chart.js';
import { getDefinition } from '../src/domain/topology.js';
import { renderBodygraph } from '../src/scene/bodygraph-svg.js';
import { renderActivationColumns } from '../src/scene/activation-columns.js';
import { PLANETS } from '../src/domain/planets.js';
import { formatDateInput, formatTimeInput, normalizeDate, normalizeTime } from '../src/views/date-input.js';

const exampleChart = (extra = {}) => ({
  id: 'chart-test',
  name: 'Мария — личная карта 🌿',
  personality: [37, 22, 1],
  design: [40, 64],
  birthDate: '1990-06-15',
  birthTime: '13:45',
  birthPlace: 'Санкт-Петербург',
  note: '<script>alert("это текст, не код")</script> & «Моя заметка»',
  createdAt: '2026-09-12T10:00:00.000Z',
  updatedAt: '2026-09-12T10:00:00.000Z',
  ...extra
});

function createMemoryStorage() {
  const entries = new Map();
  return { getItem: key => entries.get(key) ?? null, setItem: (key, value) => entries.set(key, value) };
}

test('permanent deletion removes only the selected card without creating a recovery copy', () => {
  const values = new Map();
  const storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  const charts = [validateChart(exampleChart()), validateChart(exampleChart({ id: 'other', name: 'Другая' }))];
  writeCharts(storage, charts);
  const removed = deleteChart(storage, charts, 'chart-test');
  assert.deepEqual(removed.map(c => c.id), ['other']);
  assert.deepEqual(readCharts(storage), [charts[1]]);
  assert.equal(storage.getItem(TRASH_KEY), null);
  assert.throws(() => deleteChart(storage, charts, 'missing'));
  assert.throws(() => deleteChart(storage, [exampleChart({ id: 'current-transit' })], 'current-transit'));
});

test('permanent deletion clears legacy copies of the target and preserves live data if writing fails', () => {
  const values = new Map();
  let failKey = null;
  const storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => { if (key === failKey) throw new Error('full'); values.set(key, value); } };
  const charts = [validateChart(exampleChart())];
  writeCharts(storage, charts);
  writeCharts(storage, charts, TRASH_KEY);
  failKey = TRASH_KEY;
  assert.throws(() => deleteChart(storage, charts, 'chart-test'));
  assert.deepEqual(readCharts(storage), charts);
  failKey = STORAGE_KEY;
  assert.throws(() => deleteChart(storage, charts, 'chart-test'));
  assert.deepEqual(readCharts(storage), charts);
  assert.deepEqual(readCharts(storage, TRASH_KEY), []);
  failKey = null;
  deleteChart(storage, charts, 'chart-test');
  assert.deepEqual(readCharts(storage), []);
  assert.deepEqual(readCharts(storage, TRASH_KEY), []);
});

test('gate input accepts supported separators and sorts unique gate numbers', () => {
  assert.deepEqual(parseGates(' 64, 37; 40\n1\t37 01 '), [1, 37, 40, 64]);
  assert.deepEqual(parseGates(''), []);
  assert.deepEqual(parseGates('  \n\t '), []);
  assert.deepEqual(parseGates('1 64'), [1, 64]);
});

test('gate input rejects out-of-range, non-integer, and non-numeric tokens', () => {
  for (const input of ['0', '65', '-1', '1.2', '1e1', 'NaN', 'Infinity', '2foo', '37/40', '001', '1, 65', '<script>']) {
    assert.throws(() => parseGates(input), Error, input);
  }
});

test('chart storage preserves Unicode and script-looking strings as data', () => {
  const storage = createMemoryStorage();
  const original = exampleChart();
  writeCharts(storage, [original]);
  const [roundtrip] = readCharts(storage);
  assert.deepEqual(roundtrip, validateChart(original));
  assert.equal(roundtrip.name, original.name);
  assert.equal(roundtrip.note, original.note);
  assert.deepEqual(roundtrip.personality, [1, 22, 37]);
});

test('chart validation deduplicates activations and rejects invalid numbers', () => {
  for (const invalid of [undefined, null, [], {}]) assert.throws(() => validateChart(invalid), Error);
  assert.deepEqual(validateChart(exampleChart({ personality: [37, 1, 37] })).personality, [1, 37]);
  for (const key of ['personality', 'design']) {
    for (const values of [null, '37, 40', {}, [0], [65], [-1], [1.5], ['37'], [NaN], [Infinity]]) {
      assert.throws(() => validateChart(exampleChart({ [key]: values })), Error);
    }
  }
});

test('chart limits reject oversized input; bounded note fields are trimmed', () => {
  assert.throws(() => validateChart(exampleChart({ name: 'я'.repeat(81) })), Error);
  assert.throws(() => validateChart(exampleChart({ name: ' \n ' })), Error);
  for (const key of ['personality', 'design']) {
    assert.throws(() => validateChart(exampleChart({ [key]: Array(65).fill(1) })), Error);
  }
  const chart = validateChart(exampleChart({ name: 'я'.repeat(80), note: 'н'.repeat(2100), birthPlace: 'м'.repeat(130) }));
  assert.equal(chart.name.length, 80);
  assert.equal(chart.note.length, 2000);
  assert.equal(chart.birthPlace.length, 120);
});

test('local chart library roundtrips data and rejects corrupt or oversized libraries', () => {
  const entries = new Map();
  const storage = { getItem: key => entries.get(key) ?? null, setItem: (key, value) => entries.set(key, value) };
  assert.deepEqual(readCharts(storage), []);
  writeCharts(storage, [exampleChart()]);
  assert.deepEqual(readCharts(storage), [validateChart(exampleChart())]);
  for (const content of ['{invalid', 'null', '{}', '[null]', '[{}]', '[[]]', JSON.stringify(Array(501).fill(exampleChart()))]) {
    storage.setItem(STORAGE_KEY, content);
    assert.throws(() => readCharts(storage), Error);
  }
});

test('zoom keeps the graph point beneath its anchor invariant', () => {
  const before = { x: -45, y: 130, k: 1.4 };
  const anchor = { x: 247, y: 388 };
  const graphPoint = { x: (anchor.x - before.x) / before.k, y: (anchor.y - before.y) / before.k };
  for (const factor of [0.1, 0.8, 1, 1.2, 100]) {
    const after = zoomAt(before, anchor, factor);
    assert.ok(Math.abs(after.x + graphPoint.x * after.k - anchor.x) < 1e-9);
    assert.ok(Math.abs(after.y + graphPoint.y * after.k - anchor.y) < 1e-9);
  }
  assert.deepEqual(before, { x: -45, y: 130, k: 1.4 }, 'zoom must not mutate its input');
});

test('zoom clamps its range and stays stationary when already at a limit', () => {
  const anchor = { x: 320, y: 410 };
  assert.equal(zoomAt({ x: 0, y: 0, k: 1 }, anchor, 100).k, 4.5);
  assert.equal(zoomAt({ x: 0, y: 0, k: 1 }, anchor, 0.01).k, 0.65);
  const maximum = { x: -800, y: -900, k: 4.5 };
  const minimum = { x: 15, y: -20, k: 0.65 };
  assert.deepEqual(zoomAt(maximum, anchor, 2), maximum);
  assert.deepEqual(zoomAt(minimum, anchor, 0.5), minimum);
});

test('fit centers bounds inside an offset viewport area', () => {
  const bounds = { x: 75, y: 20, width: 480, height: 790 };
  const area = { x: 22, y: 86, width: 596, height: 662 };
  const view = fitView(bounds, area);
  assert.ok(Math.abs(view.x + (bounds.x + bounds.width / 2) * view.k - (area.x + area.width / 2)) < 1e-9);
  assert.ok(Math.abs(view.y + (bounds.y + bounds.height / 2) * view.k - (area.y + area.height / 2)) < 1e-9);
  assert.ok(validView(view));
});

test('fit contains the complete drawing and uses the limiting dimension', () => {
  const bounds = { x: -40, y: 30, width: 300, height: 500 };
  for (const area of [
    { x: 25, y: 80, width: 600, height: 650 },
    { x: 10, y: 15, width: 240, height: 800 }
  ]) {
    const view = fitView(bounds, area);
    assert.equal(view.k, Math.min(area.width / bounds.width, area.height / bounds.height));
    const left = view.x + bounds.x * view.k;
    const top = view.y + bounds.y * view.k;
    const right = left + bounds.width * view.k;
    const bottom = top + bounds.height * view.k;
    assert.ok(left >= area.x - 1e-9 && top >= area.y - 1e-9);
    assert.ok(right <= area.x + area.width + 1e-9 && bottom <= area.y + area.height + 1e-9);
    assert.ok(Math.abs(right - left - area.width) < 1e-9 || Math.abs(bottom - top - area.height) < 1e-9);
  }
});

test('fit clamps extreme scales to the same supported zoom range', () => {
  const bounds = { x: 0, y: 0, width: 100, height: 100 };
  const small = fitView(bounds, { x: 0, y: 0, width: 10, height: 10 });
  const large = fitView(bounds, { x: 0, y: 0, width: 2000, height: 2000 });
  assert.equal(small.k, 0.65);
  assert.equal(large.k, 4.5);
  assert.ok(validView(small));
  assert.ok(validView(large));
  assert.equal(small.x + 50 * small.k, 5);
  assert.equal(large.x + 50 * large.k, 1000);
});

test('saved view validation accepts bounds and rejects non-finite or oversized coordinates', () => {
  assert.ok(validView({ x: 0, y: 0, k: 1 }));
  assert.ok(validView({ x: -5000, y: 6000, k: 0.65 }));
  assert.ok(validView({ x: 5000, y: -6000, k: 4.5 }));
  for (const view of [null, undefined, {}, { x: 0, y: 0 }, { x: NaN, y: 0, k: 1 }, { x: 0, y: Infinity, k: 1 }, { x: 0, y: 0, k: '1' }, { x: 0, y: 0, k: 0.64 }, { x: 0, y: 0, k: 4.51 }, { x: 5001, y: 0, k: 1 }, { x: 0, y: -6001, k: 1 }]) {
    assert.ok(!validView(view));
  }
});

test('bodygraph topology contains 64 unique gates, nine centers and 36 distinct channels', () => {
  assert.equal(GATES.length, 64);
  assert.deepEqual([...new Set(GATES.map(gate => gate.id))].sort((a, b) => a - b), Array.from({ length: 64 }, (_, i) => i + 1));
  assert.equal(CENTERS.length, 9);
  assert.equal(new Set(CENTERS.map(center => center.id)).size, 9);
  assert.equal(CHANNELS.length, 36);
  assert.equal(new Set(CHANNELS.map(channel => channel.id)).size, 36);

  for (const gate of GATES) {
    assert.ok(getCenter(gate.center), `gate ${gate.id} has a valid center`);
    assert.ok(Number.isFinite(gate.x) && Number.isFinite(gate.y), `gate ${gate.id} has finite coordinates`);
    assert.ok(CHANNELS.some(channel => channel.gates.includes(gate.id)), `gate ${gate.id} has a channel`);
  }
  for (const channel of CHANNELS) {
    assert.equal(channel.gates.length, 2);
    const [a, b] = channel.gates.map(getGate);
    assert.ok(a && b, `${channel.id} endpoints exist`);
    assert.notEqual(a.id, b.id);
    assert.notEqual(a.center, b.center, `${channel.id} connects different centers`);
    assert.equal(channel.id, [...channel.gates].sort((x, y) => x - y).join('-'));
  }
});

test('channel 37–40 joins solar plexus to the heart and resolves either order', () => {
  const channel = getChannel('37-40');
  assert.ok(channel);
  assert.deepEqual(new Set(channel.gates), new Set([37, 40]));
  assert.equal(getGate(37).center, 'solar');
  assert.equal(getGate(40).center, 'heart');
  assert.equal(getChannel('40-37'), channel);
});

test('throat, sacral and root retain matching rectangular bounds on the same axis', () => {
  let expectedSize;
  for (const id of ['throat', 'sacral', 'root']) {
    const points = getCenter(id).points.split(/\s+/).map(point => point.split(',').map(Number));
    const xs = [...new Set(points.map(([x]) => x))].sort((a, b) => a - b);
    const ys = [...new Set(points.map(([, y]) => y))].sort((a, b) => a - b);
    assert.equal(points.length, 4, `${id} has four corners`);
    assert.equal(xs.length, 2, `${id} has vertical sides`);
    assert.equal(ys.length, 2, `${id} has horizontal sides`);
    assert.deepEqual(new Set(points.map(point => point.join(','))), new Set(xs.flatMap(x => ys.map(y => `${x},${y}`))), `${id} includes every corner`);
    const size = [xs[1] - xs[0], ys[1] - ys[0]];
    expectedSize ??= size;
    assert.deepEqual(size, expectedSize, `${id} matches the other rectangular centers`);
    assert.ok(size.every(value => value > 0), `${id} has positive dimensions`);
    assert.equal((xs[0] + xs[1]) / 2, 320, `${id} stays on the central axis`);
  }
});

test('central centers have positive breathing room and side centers remain mirror images', () => {
  const bounds = id => {
    const points = getCenter(id).points.split(/\s+/).map(point => point.split(',').map(Number));
    return { top: Math.min(...points.map(point => point[1])), bottom: Math.max(...points.map(point => point[1])) };
  };
  const sequence = ['head', 'ajna', 'throat', 'g', 'sacral', 'root'];
  for (let i = 1; i < sequence.length; i++) {
    const gap = bounds(sequence[i]).top - bounds(sequence[i - 1]).bottom;
    assert.ok(gap >= 12, `${sequence[i - 1]} to ${sequence[i]} has room for distinct channel ends`);
  }
  const left = getCenter('spleen').points.split(/\s+/).map(point => point.split(',').map(Number));
  const right = getCenter('solar').points.split(/\s+/);
  assert.deepEqual(new Set(left.map(([x, y]) => `${640 - x},${y}`)), new Set(right));
});

test('channels clear unrelated centers, including 12–22 past the ego', () => {
  const distance = (p, a, b) => {
    const d = b.map((v, i) => v - a[i]);
    const t = Math.max(0, Math.min(1, d.reduce((sum, v, i) => sum + (p[i] - a[i]) * v, 0) / d.reduce((sum, v) => sum + v * v, 0)));
    return Math.hypot(...p.map((v, i) => v - a[i] - t * d[i]));
  };
  for (const channel of CHANNELS) {
    if (channel.gates.every(id => [10, 20, 34, 57].includes(id))) continue; // Rendered as the shared integration stem.
    const connected = channel.gates.map(id => getGate(id).center);
    for (const center of CENTERS.filter(c => !connected.includes(c.id))) {
      const polygon = center.points.split(' ').map(p => p.split(',').map(Number));
      for (const curve of channel.curves) for (let step = 0; step <= 100; step++) {
        const t = step / 100, u = 1 - t;
        const p = [0, 1].map(axis => u ** 3 * curve[0][axis] + 3 * u * u * t * curve[1][axis] + 3 * u * t * t * curve[2][axis] + t ** 3 * curve[3][axis]);
        const gap = Math.min(...polygon.map((a, i) => distance(p, a, polygon[(i + 1) % polygon.length])));
        assert.ok(gap >= 8, `${channel.id} needs stroke and selection clearance from ${center.id}: ${gap}`);
      }
    }
  }
});

test('planet selection is independent of gate selection in both activation columns', () => {
  const chart = calculatedChart();
  const markup = renderBodygraph(chart, { type: 'planet', id: 'design-sun' }, { showActivations: true });
  assert.equal((markup.match(/class="bg-activation bg-planet"/g) || []).length, 26);
  const selected = [...markup.matchAll(/<g[^>]+data-type="(planet|gate)"[^>]+aria-pressed="true"[^>]*>/g)];
  assert.equal(selected.length, 1);
  assert.equal(selected[0][1], 'planet');
  assert.match(selected[0][0], /data-id="design-sun"/);
  assert.doesNotMatch(markup, /data-highlight-gate=/);
  assert.ok(markup.includes('translate(-32 118)') && markup.includes('translate(584 118)'), 'columns have a common baseline and mirrored outer bounds');
  assert.ok(markup.includes('translate(-32 694)') && markup.includes('translate(584 694)'), 'columns extend almost to the root');
  assert.match(markup, /font-size="24"/);
});

test('26–44 exits its own gate clear of gate 50 and is painted behind every other channel', () => {
  const channel = getChannel('26-44'), otherGate = getGate(50);
  assert.deepEqual(channel.curves[0][0], [getGate(44).x, getGate(44).y]);
  assert.deepEqual(channel.curves.at(-1).at(-1), [getGate(26).x, getGate(26).y]);
  for (const curve of channel.curves) for (let step = 0; step <= 100; step++) {
    const t = step / 100, u = 1 - t;
    const [x, y] = [0, 1].map(axis => u ** 3 * curve[0][axis] + 3 * u * u * t * curve[1][axis] + 3 * u * t * t * curve[2][axis] + t ** 3 * curve[3][axis]);
    assert.ok(Math.hypot(x - otherGate.x, y - otherGate.y) >= 20, 'route clears the gate disc and selection halo');
  }
  const markup = renderBodygraph({ personality: [26], design: [44] }, { type: 'channel', id: '26-44' });
  const order = interactiveGroups(markup, 'channel').map(group => group.id);
  assert.equal(order[0], '26-44');
  assert.ok(markup.indexOf('data-id="26-44"') < markup.indexOf('data-junction="integration"'));
});

test('activation columns preserve real planet and line values, source colors and ordering', () => {
  const chart = calculatedChart();
  chart.activations.personality.reverse();
  const markup = renderActivationColumns(chart, new Set([33]));
  assert.equal((markup.match(/class="bg-activation"/g) || []).length, 26);
  assert.match(markup, /data-source="design" fill="#c32d35"/);
  assert.match(markup, /data-source="personality" fill="#202020"/);
  assert.ok(markup.indexOf('data-source="design"') < markup.indexOf('data-source="personality"'));
  for (const source of ['design', 'personality']) {
    let previous = -1;
    for (const [planet] of PLANETS) {
      const entry = chart.activations[source].find(item => item.planet === planet);
      const position = markup.indexOf(`data-activation="${source}-${planet}"`);
      assert.ok(position > previous, `${source} ${planet} order`);
      previous = position;
      const row = markup.slice(position, markup.indexOf('</g>', position));
      assert.match(row, new RegExp(`ворота ${entry.gate}, линия ${entry.line}`));
      assert.ok(row.includes(`data-selected="${entry.gate === 33}"`));
    }
  }
});

test('activation columns never invent planets for manual charts or design activations for a transit', () => {
  assert.equal(renderActivationColumns({ personality: [7], design: [31] }), '');
  const chart = calculatedChart();
  chart.source = 'transit'; chart.activations.design = [];
  const markup = renderActivationColumns(chart);
  assert.equal((markup.match(/class="bg-activation"/g) || []).length, 13);
  assert.doesNotMatch(markup, /data-source="design"|>Дизайн</);
  assert.match(markup, />Транзит</);
});

test('upper outer channels stay narrow and mirror one another around the central axis', () => {
  const left = getChannel('17-62').curve;
  const right = getChannel('11-56').curve;
  assert.equal(left.length, 4);
  assert.equal(right.length, 4);
  for (const [index, [x, y]] of left.entries()) {
    assert.equal(x + right[index][0], 640, `control point ${index} mirrors across x=320`);
    assert.equal(y, right[index][1], `control point ${index} has matching height`);
  }
  for (const [id, curve] of [['17-62', left], ['11-56', right]]) {
    const xs = curve.map(([x]) => x);
    const throatX = getCenter('throat').points.split(/\s+/).map(point => Number(point.split(',')[0]));
    const throatWidth = Math.max(...throatX) - Math.min(...throatX);
    assert.ok(Math.max(...xs) - Math.min(...xs) <= throatWidth / 3, `${id} horizontal span remains near vertical`);
    assert.ok(xs.every(x => x >= Math.min(...throatX) && x <= Math.max(...throatX)), `${id} stays in the narrow upper corridor`);
    assert.ok(curve.every((point, index) => index === 0 || point[1] > curve[index - 1][1]), `${id} progresses downward without folding`);
    const gates = getChannel(id).gates.map(getGate);
    assert.deepEqual(curve[0], [gates[0].x, gates[0].y], `${id} starts at its gate`);
    assert.deepEqual(curve[3], [gates[1].x, gates[1].y], `${id} ends at its gate`);
  }
});

test('defined centers use their traditional color family and undefined centers stay white', () => {
  const expected = {
    head: '#edcd4c', ajna: '#79a367', throat: '#b58a60', g: '#edcd4c',
    heart: '#da514b', spleen: '#b58a60', solar: '#b58a60', sacral: '#da514b', root: '#b58a60'
  };
  for (const chart of [
    {},
    { personality: GATES.map(gate => gate.id), design: [] },
    { personality: [], design: GATES.map(gate => gate.id) },
    { personality: [37], design: [40] }
  ]) {
    const markup = renderBodygraph(chart);
    const defined = getDefinition(chart).centers;
    const groups = [...markup.matchAll(/<g\s+data-type="center"\s+data-id="([^"]+)"[^>]*>([\s\S]*?)<\/g>/g)];
    assert.equal(groups.length, 9);
    for (const [, id, content] of groups) {
      const fill = content.match(/<(?:polygon|path)\s+class="bg-center-shape"[^>]*\sfill="([^"]+)"/);
      assert.ok(fill, `${id} has a center fill`);
      assert.equal(fill[1], defined.has(id) ? expected[id] : '#ffffff', `${id} fill follows center definition`);
    }
  }
});

test('a hanging gate alone does not define a channel or a center', () => {
  assert.equal(getDefinition().channels.length, 0);
  assert.equal(getDefinition().centers.size, 0);
  for (const gate of GATES) {
    for (const chart of [{ personality: [gate.id], design: [] }, { personality: [], design: [gate.id] }]) {
      const definition = getDefinition(chart);
      assert.equal(definition.channels.length, 0, `hanging gate ${gate.id}`);
      assert.equal(definition.centers.size, 0, `center must remain undefined for gate ${gate.id}`);
    }
  }
});

test('complete channels combine personality and design activations to define their two centers', () => {
  for (const channel of CHANNELS) {
    const [a, b] = channel.gates;
    for (const chart of [
      { personality: [a], design: [b] },
      { personality: [b], design: [a] },
      { personality: [a, b], design: [] },
      { personality: [], design: [a, b] },
      { personality: [a, b], design: [a, b] }
    ]) {
      const definition = getDefinition(chart);
      assert.deepEqual(definition.channels.map(item => item.id), [channel.id]);
      assert.deepEqual(definition.centers, new Set([getGate(a).center, getGate(b).center]));
    }
  }
});

function interactiveGroups(markup, type) {
  return [...markup.matchAll(new RegExp(`<g\\s+data-type="${type}"\\s+data-id="([^"]+)"([^>]*)>`, 'g'))]
    .map(([, id, attributes]) => ({ id, attributes }));
}

test('demo renders all 64 gates, nine centers and 36 channels as keyboard-operable buttons', () => {
  const markup = renderBodygraph(DEMO_CHART);
  for (const [type, count] of [['gate', 64], ['center', 9], ['channel', 36]]) {
    const groups = interactiveGroups(markup, type);
    assert.equal(groups.length, count);
    assert.equal(new Set(groups.map(group => group.id)).size, count);
    for (const { id, attributes } of groups) {
      assert.match(attributes, /\brole="button"/, `${type} ${id} role`);
      assert.match(attributes, /\btabindex="0"/, `${type} ${id} keyboard focus`);
      assert.match(attributes, /\baria-label="[^"]+"/, `${type} ${id} accessible name`);
    }
  }
  assert.deepEqual(interactiveGroups(markup, 'gate').map(group => Number(group.id)).sort((a, b) => a - b), Array.from({ length: 64 }, (_, i) => i + 1));
});

test('gate selection highlights only that gate and its own channel halves, including integration', () => {
  for (const { id } of GATES) {
    const markup = renderBodygraph(DEMO_CHART, { type: 'gate', id });
    const gates = interactiveGroups(markup, 'gate');
    assert.equal(gates.length, 64);
    assert.deepEqual(gates.filter(group => /aria-pressed="true"/.test(group.attributes)).map(group => Number(group.id)), [id]);
    assert.deepEqual(gates.filter(group => /data-related="true"/.test(group.attributes)).map(group => Number(group.id)), [id]);
    const relatedChannels = interactiveGroups(markup, 'channel').filter(group => /data-related="true"/.test(group.attributes)).map(group => group.id);
    assert.deepEqual(new Set(relatedChannels), new Set(CHANNELS.filter(channel => channel.gates.includes(id)).map(channel => channel.id)));
    assert.ok(interactiveGroups(markup, 'channel').every(group => /aria-pressed="false"/.test(group.attributes)));
    const halfGates = [...markup.matchAll(/data-highlight-gate="(\d+)"/g)].map(match => Number(match[1]));
    const arms = [...markup.matchAll(/data-arm="(\d+)" data-related="true"/g)].map(match => Number(match[1]));
    if ([10, 20, 34, 57].includes(id)) {
      assert.deepEqual(arms, [id]);
      assert.deepEqual(halfGates, []);
    } else {
      assert.deepEqual(new Set(halfGates), new Set([id]));
      assert.deepEqual(arms, []);
    }
  }
});

test('center selection highlights only its own gates and their channel halves', () => {
  for (const center of CENTERS) {
    const markup = renderBodygraph(DEMO_CHART, { type: 'center', id: center.id });
    const expected = GATES.filter(gate => gate.center === center.id).map(gate => gate.id);
    const related = interactiveGroups(markup, 'gate').filter(group => /data-related="true"/.test(group.attributes)).map(group => Number(group.id));
    assert.deepEqual(related, expected, center.id);
    assert.deepEqual(interactiveGroups(markup, 'center').filter(group => /aria-pressed="true"/.test(group.attributes)).map(group => group.id), [center.id]);
    const halfGates = [...markup.matchAll(/data-highlight-gate="(\d+)"/g)].map(match => Number(match[1]));
    const ordinaryGates = expected.filter(id => ![10, 20, 34, 57].includes(id));
    assert.deepEqual(new Set(halfGates), new Set(ordinaryGates), `${center.id} ordinary halves`);
    const arms = [...markup.matchAll(/data-arm="(\d+)" data-related="true"/g)].map(match => Number(match[1]));
    assert.deepEqual(new Set(arms), new Set(expected.filter(id => [10, 20, 34, 57].includes(id))), `${center.id} integration branches`);
    for (const [, gateId, path] of markup.matchAll(/data-highlight-gate="(\d+)"><path d="([^"]+)"/g)) {
      const gate = getGate(Number(gateId));
      const coordinate = `${gate.x.toFixed(2)},${gate.y.toFixed(2)}`;
      assert.ok(path.startsWith(`M${coordinate}`) || path.endsWith(`L${coordinate}`), 'a half starts or ends at its own gate');
    }
  }
});

test('channel selection highlights the full connection and both gates, not other gates', () => {
  for (const channel of CHANNELS) {
    const markup = renderBodygraph(DEMO_CHART, { type: 'channel', id: channel.id });
    const related = interactiveGroups(markup, 'gate').filter(group => /data-related="true"/.test(group.attributes)).map(group => Number(group.id));
    assert.deepEqual(new Set(related), new Set(channel.gates), channel.id);
    assert.deepEqual(interactiveGroups(markup, 'channel').filter(group => /data-related="true"/.test(group.attributes)).map(group => group.id), [channel.id]);
    if (channel.gates.every(id => [10, 20, 34, 57].includes(id))) {
      const arms = [...markup.matchAll(/data-arm="(\d+)" data-related="true"/g)].map(match => Number(match[1]));
      assert.deepEqual(new Set(arms), new Set(channel.gates));
    } else {
      assert.ok(markup.includes(`d="${channel.path}" fill="none" stroke="#c4d9f1" stroke-width="13.2"`));
    }
  }
});

test('integration selection outlines sit above ordinary channels and below their own physical branches', () => {
  const chart = { personality: [20, 10, 34, 57], design: [20, 10, 34, 57] };
  for (const selection of [
    ...['throat', 'g', 'sacral', 'spleen'].map(id => ({ type: 'center', id })),
    ...[20, 10, 34, 57].map(id => ({ type: 'gate', id })),
    { type: 'channel', id: '20-34' }, { type: 'integration', id: 'integration' }
  ]) {
    const markup = renderBodygraph(chart, selection);
    const integration = markup.slice(markup.indexOf('<g class="bodygraph-channels">'));
    const halo = integration.match(/<path class="bg-integration-selection"[^>]+\/>/);
    assert.ok(halo, `${selection.id} has a selection halo`);
    assert.match(halo[0], /fill="none" stroke="#c4d9f1" stroke-width="13.2"/);
    assert.match(halo[0], new RegExp(`stroke-linecap="${selection.type === 'integration' ? 'butt' : 'round'}"`), 'partial candidates cover the exact terminal plane; ownership masks set their visible ends');
    const bundleStart = integration.indexOf('data-junction="integration"');
    assert.ok(integration.indexOf(halo[0]) > integration.indexOf('data-type="channel" data-id="26-44"'), 'selected outline is above the ordinary crossing');
    assert.ok(integration.indexOf(halo[0]) < integration.indexOf('stroke="#c6c2b9"', bundleStart), 'selected outline is below its own physical channel outlines');
    assert.ok(integration.indexOf(halo[0]) < integration.indexOf('class="bg-integration-arm"'), 'selected outline is below all branches');
    const maskId = selection.type === 'integration' ? 'integration-outline' : 'integration-selection-outline';
    assert.ok(halo[0].includes(`mask="url(#bodygraph-${maskId})"`), 'the lower outline retains its exterior ownership mask');
    for (const gate of [20, 10, 34, 57]) {
      const arm = integration.match(new RegExp(`<g class="bg-integration-arm" data-arm="${gate}"[^>]*>([\\s\\S]*?)<\\/g>`))[1];
      assert.match(arm, /stroke="#202020"/);
      assert.match(arm, /stroke="#c32d35"/);
    }
  }
});

test('the default camera uses a fixed symmetric frame instead of chart-content bounds', t => {
  const originalPoint = Object.getOwnPropertyDescriptor(globalThis, 'DOMPoint');
  globalThis.DOMPoint = class {
    constructor(x, y) { this.x = x; this.y = y; }
    matrixTransform() { return this; }
  };
  t.after(() => { if (originalPoint) Object.defineProperty(globalThis, 'DOMPoint', originalPoint); else delete globalThis.DOMPoint; });
  const svg = {
    addEventListener() {}, getScreenCTM: () => ({ inverse: () => ({}) }),
    classList: { add() {}, remove() {}, toggle() {} },
    getBoundingClientRect: () => ({ left: 0, top: 0, right: 640, bottom: 820, width: 640, height: 820 })
  };
  const viewport = { setAttribute() {}, getBBox() { throw new Error('Content must never choose the camera'); } };
  const controls = attachGestures(svg, viewport, { onSelect() {}, onChange() {} });
  controls.reset();
  const expected = fitView(DRAWING_BOUNDS, { x: 22, y: 128, width: 596, height: 620 });
  assert.deepEqual(controls.getView(), expected);
  assert.equal(expected.x + 320 * expected.k, 320, 'the central axis remains centered');
  controls.setView({ x: -300, y: 100, k: 2 });
  controls.reset();
  assert.deepEqual(controls.getView(), expected, 'the same default is restored after any pan or zoom');
});

test('only a background tap clears selection; dragging, pinching and cancelled pointers do not', t => {
  const originalPoint = Object.getOwnPropertyDescriptor(globalThis, 'DOMPoint');
  globalThis.DOMPoint = class {
    constructor(x, y) { this.x = x; this.y = y; }
    matrixTransform() { return this; }
  };
  t.after(() => { if (originalPoint) Object.defineProperty(globalThis, 'DOMPoint', originalPoint); else delete globalThis.DOMPoint; });
  const listeners = new Map(), captures = new Set(), selected = [];
  let cleared = 0;
  const svg = {
    addEventListener: (name, callback) => listeners.set(name, callback),
    getScreenCTM: () => ({ inverse: () => ({}) }),
    setPointerCapture: id => captures.add(id),
    hasPointerCapture: id => captures.has(id),
    releasePointerCapture: id => captures.delete(id),
    classList: { add() {}, remove() {}, toggle() {} }
  };
  const controls = attachGestures(svg, { setAttribute() {} }, {
    onSelect: value => selected.push(value), onChange() {}, onBackgroundTap: () => cleared++
  });
  const gate = { dataset: { type: 'gate', id: '37' } };
  const send = (type, extra = {}) => listeners.get(type)({ type, pointerId: 1, pointerType: 'touch', button: 0,
    clientX: 100, clientY: 100, target: { closest: () => null }, ...extra });
  send('pointerdown'); send('pointerup');
  assert.equal(cleared, 1);
  send('pointerdown', { target: { closest: () => gate } }); send('pointerup');
  assert.deepEqual(selected, [{ type: 'gate', id: '37', pointerType: 'touch' }]);
  assert.equal(cleared, 1);
  send('pointerdown'); send('pointermove', { clientX: 140 }); send('pointerup', { clientX: 140 });
  assert.equal(cleared, 1);
  assert.equal(controls.getView().x, 0, 'the fitted camera does not pan at 100%');
  controls.zoom(2);
  const zoomedX = controls.getView().x;
  send('pointerdown'); send('pointermove', { clientX: 140 }); send('pointerup', { clientX: 140 });
  assert.equal(controls.getView().x, zoomedX + 40, 'panning is available above 100%');
  assert.equal(cleared, 1, 'a zoomed drag preserves selection');
  send('pointerdown'); send('pointerup', { clientX: 140 });
  assert.equal(cleared, 1, 'release displacement is checked even without a move event');
  send('pointerdown'); send('pointerdown', { pointerId: 2, clientX: 200 });
  send('pointermove', { pointerId: 2, clientX: 250 });
  send('pointerup', { pointerId: 2, clientX: 250 }); send('pointerup');
  assert.equal(cleared, 1);
  send('pointerdown'); send('pointercancel');
  assert.equal(cleared, 1);
  send('pointerdown'); send('lostpointercapture'); send('pointerup');
  assert.equal(cleared, 1);
  send('pointerdown'); send('pointerup');
  assert.equal(cleared, 2, 'a fresh tap still works after cancelled gestures');
});

test('pointer and keyboard selections retain activation identity with per-press input context', t => {
  const originalPoint = Object.getOwnPropertyDescriptor(globalThis, 'DOMPoint');
  globalThis.DOMPoint = class {
    constructor(x, y) { this.x = x; this.y = y; }
    matrixTransform() { return this; }
  };
  t.after(() => { if (originalPoint) Object.defineProperty(globalThis, 'DOMPoint', originalPoint); else delete globalThis.DOMPoint; });
  const listeners = new Map(), captures = new Set(), selected = [];
  const svg = {
    addEventListener: (name, callback) => listeners.set(name, callback),
    getScreenCTM: () => ({ inverse: () => ({}) }),
    setPointerCapture: id => captures.add(id),
    hasPointerCapture: id => captures.has(id),
    releasePointerCapture: id => captures.delete(id),
    classList: { add() {}, remove() {}, toggle() {} },
  };
  attachGestures(svg, { setAttribute() {} }, { onSelect: value => selected.push(value), onChange() {} });
  const datasets = [
    { type: 'gate', id: '4' },
    { type: 'center', id: 'ajna' },
    { type: 'channel', id: '4-63' },
    { type: 'integration', id: 'integration' },
    { type: 'gate', id: '4', activation: 'personality-mercury' },
    { type: 'gate', id: '4', activation: 'personality-mars' },
    { type: 'gate', id: '4', activation: 'design-mercury' },
    { type: 'planet', id: 'personality-mercury', activation: 'personality-mercury-planet' },
  ];
  for (const dataset of datasets) {
    const target = { closest: () => ({ dataset }) };
    for (const type of ['pointerdown', 'pointerup']) {
      let prevented = false;
      listeners.get(type)({ type, pointerId: 1, pointerType: 'touch', button: 0, clientX: 100, clientY: 100, target, preventDefault() { prevented = true; } });
      assert.equal(prevented, type === 'pointerdown' && Boolean(dataset.activation), 'only activation presses suppress delayed native touch focus');
    }
    assert.deepEqual(selected.at(-1), { ...dataset, pointerType: 'touch' }, `${dataset.activation || dataset.type} tap payload`);
    for (const key of ['Enter', ' ']) {
      let prevented = false;
      listeners.get('keydown')({ target, key, preventDefault() { prevented = true; } });
      assert.equal(prevented, true, `${key} is handled as a selection`);
      assert.deepEqual(selected.at(-1), dataset, `${dataset.activation || dataset.type} keyboard payload`);
    }
  }
  assert.equal(selected.length, datasets.length * 3, 'each tap and supported key selects exactly once');
});

test('empty charts remain undefined, and library thumbnails are excluded from keyboard navigation', () => {
  const markup = renderBodygraph({ personality: [], design: [] });
  assert.ok(interactiveGroups(markup, 'center').every(group => /data-defined="false"/.test(group.attributes)));
  assert.ok(interactiveGroups(markup, 'channel').every(group => /data-defined="false"/.test(group.attributes)));
  assert.ok(interactiveGroups(markup, 'gate').every(group => /data-active="false"/.test(group.attributes)));
  const thumbnail = renderBodygraph(DEMO_CHART, null, { interactive: false, idPrefix: 'thumbnail' });
  assert.equal(interactiveGroups(thumbnail, 'gate').length, 64);
  assert.doesNotMatch(thumbnail, /tabindex="0"|role="button"/);
});

test('numeric date formatting inserts separators progressively and accepts ISO dates', () => {
  for (const [input, expected] of [
    ['', ''], ['1', '1'], ['12', '12'], ['123', '12.3'], ['1234', '12.34'],
    ['12091990', '12.09.1990'], ['12.09.1990', '12.09.1990'],
    ['1990-09-12', '12.09.1990'], ['12091990123', '12.09.1990'],
    [null, ''], [undefined, '']
  ]) {
    assert.equal(formatDateInput(input), expected);
  }
});

test('numeric time formatting inserts the colon and accepts single-digit hours with minutes', () => {
  for (const [input, expected] of [
    ['', ''], ['1', '1'], ['12', '12'], ['123', '12:3'], ['1234', '12:34'],
    ['0905', '09:05'], ['9:05', '09:05'], ['23:59', '23:59'], ['123456', '12:34'],
    [null, '']
  ]) {
    assert.equal(formatTimeInput(input), expected);
  }
});

test('numeric dates normalize to ISO with Gregorian leap-year validation', () => {
  for (const [input, expected] of [
    ['12091990', '1990-09-12'], ['29.02.2000', '2000-02-29'],
    ['29022024', '2024-02-29'], ['2024-02-29', '2024-02-29'], ['01010001', '0001-01-01']
  ]) {
    assert.equal(normalizeDate(input), expected);
  }
  for (const input of ['', '120919', '00012024', '01132024', '31042024', '30022024', '29021900', '29022023', '01010000']) {
    assert.throws(() => normalizeDate(input), Error, input);
  }
});

test('numeric times normalize and reject incomplete or impossible times', () => {
  for (const [input, expected] of [['0000', '00:00'], ['2359', '23:59'], ['0905', '09:05'], ['9:05', '09:05'], ['12:34', '12:34']]) {
    assert.equal(normalizeTime(input), expected);
  }
  for (const input of ['', '9', '093', '2400', '2360', '9960']) {
    assert.throws(() => normalizeTime(input), Error, input);
  }
});

function calculatedChart() {
  // Snapshot shape and solar/planetary positions from the local Swiss calculation;
  // this fixture checks storage fidelity, not independent astronomical precision.
  const bodies = ['sun', 'earth', 'moon', 'north_node', 'south_node', 'mercury', 'venus', 'mars', 'jupiter', 'saturn', 'uranus', 'neptune', 'pluto'];
  const entries = values => values.map(([longitude, gate, line], index) => ({ planet: bodies[index], longitude, gate, line }));
  const activations = {
    personality: entries([
      [130.0915947689021, 33, 3], [310.0915947689021, 19, 3], [39.794064415580436, 24, 3],
      [295.9516312010691, 61, 6], [115.95163120106912, 62, 6], [139.51047463569802, 4, 1],
      [87.36240599435514, 12, 6], [141.92815742432805, 4, 4], [269.30525579360716, 10, 2],
      [77.41933842292637, 45, 1], [194.93777553357157, 48, 6], [242.52320807472617, 34, 3], [180.07400541891536, 46, 2]
    ]),
    design: entries([
      [42.091594768628525, 24, 5], [222.0915947686285, 44, 5], [264.70221480444167, 11, 3],
      [299.0268612153428, 60, 3], [119.02686121534282, 56, 3], [15.569136190043833, 51, 1],
      [84.97613518653193, 12, 3], [83.49022900929226, 12, 1], [278.23799950845176, 58, 5],
      [66.26752514974926, 16, 1], [195.2086871905143, 57, 1], [244.47964337134297, 34, 5], [179.67956898525415, 46, 2]
    ])
  };
  return exampleChart({
    id: 'calculated-test', name: 'Карта — Бангкок', source: 'calculated',
    personality: [...new Set(activations.personality.map(item => item.gate))].sort((a, b) => a - b),
    design: [...new Set(activations.design.map(item => item.gate))].sort((a, b) => a - b),
    birthDate: '1972-08-02', birthTime: '14:30', birthPlace: 'Бангкок',
    timezone: 'Asia/Bangkok', utc: '1972-08-02T07:30:00Z', utcOffset: 'UTC+07:00', fold: 0,
    designUtc: '1972-05-02T09:58:47Z', cityId: '1609350',
    city: { id: '1609350', name: 'Бангкок', country: 'TH', region: 'Bangkok', timezone: 'Asia/Bangkok', latitude: 13.75398, longitude: 100.50144 },
    activations, engine: 'Swiss Ephemeris 2.10.03', ephemeris: 'Swiss files: sepl_18.se1 + semo_18.se1',
    timezoneDatabase: 'IANA tzdata 2026.3', nodeModel: 'true', zodiac: 'tropical-geocentric-apparent',
    designArcResidualDegrees: 2.7357316412235377e-10,
    verification: 'Engine and timezone regression checks; independent Human Design reference-chart comparison pending.'
  });
}

test('calculated chart storage retains both activation streams and calculation provenance', () => {
  const storage = createMemoryStorage();
  const original = calculatedChart();
  writeCharts(storage, [original]);
  const [roundtrip] = readCharts(storage);
  for (const key of ['source', 'personality', 'design', 'activations', 'timezone', 'utc', 'utcOffset', 'fold', 'designUtc', 'cityId', 'city', 'engine', 'ephemeris', 'timezoneDatabase', 'nodeModel', 'zodiac', 'designArcResidualDegrees', 'verification']) {
    assert.deepEqual(roundtrip[key], original[key], `preserve ${key}`);
  }
  writeCharts(storage, [roundtrip]);
  assert.deepEqual(readCharts(storage), [roundtrip], 'repeated saves remain stable');
});

test('transit chart storage keeps its source and absence of design activations', () => {
  const storage = createMemoryStorage();
  const original = calculatedChart();
  Object.assign(original, {
    source: 'transit', name: 'Текущий момент', design: [], designUtc: null, designArcResidualDegrees: null,
    city: null, cityId: null, timezone: 'UTC', utcOffset: 'UTC+00:00'
  });
  original.activations.design = [];
  writeCharts(storage, [original]);
  const [roundtrip] = readCharts(storage);
  assert.equal(roundtrip.source, 'transit');
  assert.deepEqual(roundtrip.design, []);
  assert.deepEqual(roundtrip.activations, original.activations);
  assert.equal(roundtrip.designUtc, null);
  assert.equal(roundtrip.designArcResidualDegrees, null);
});

test('calculated chart validation rejects invalid activation records', () => {
  for (const invalid of [
    { gate: 0 }, { gate: 65 }, { gate: '33' }, { line: 0 }, { line: 7 }, { line: 1.5 },
    { longitude: -0.1 }, { longitude: 360 }, { longitude: NaN }, { longitude: Infinity }, { longitude: '130' },
    { planet: 'invented_planet' }, { planet: '<script>alert(1)</script>' }
  ]) {
    const chart = calculatedChart();
    Object.assign(chart.activations.personality[0], invalid);
    assert.throws(() => validateChart(chart), Error, JSON.stringify(invalid));
  }
  for (const invalid of [null, {}, '33.3', []]) {
    const chart = calculatedChart();
    chart.activations.personality = invalid;
    assert.throws(() => validateChart(chart), Error);
  }
});

test('calculated chart validation rejects duplicate planets and gates inconsistent with activation details', () => {
  const duplicate = calculatedChart();
  duplicate.activations.personality[1] = { ...duplicate.activations.personality[0] };
  assert.throws(() => validateChart(duplicate), Error);
  const inconsistent = calculatedChart();
  inconsistent.personality = [1];
  assert.throws(() => validateChart(inconsistent), Error);
});
