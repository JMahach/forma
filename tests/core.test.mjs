import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseGates, validateChart, encodeChart, decodeChart,
  readCharts, writeCharts, STORAGE_KEY
} from '../storage.js';
import { zoomAt, validView, fitView } from '../gestures.js';
import {
  CENTERS, GATES, CHANNELS, DEMO_CHART,
  getGate, getCenter, getChannel, getDefinition
} from '../graph-data.js';
import { renderBodygraph } from '../bodygraph.js';
import { formatDateInput, formatTimeInput, normalizeDate, normalizeTime } from '../date-input.js';

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

test('chart export and import preserve Unicode and script-looking strings as data', () => {
  const original = exampleChart();
  const encoded = encodeChart(original);
  assert.equal(JSON.parse(encoded).format, 'liniya-chart');
  assert.equal(JSON.parse(encoded).version, 1);
  assert.deepEqual(decodeChart(encoded), validateChart(original));
  assert.equal(decodeChart(encoded).name, original.name);
  assert.equal(decodeChart(encoded).note, original.note);
  assert.deepEqual(decodeChart(encoded).personality, [1, 22, 37]);
});

test('chart validation deduplicates activations and rejects invalid numbers', () => {
  assert.deepEqual(validateChart(exampleChart({ personality: [37, 1, 37] })).personality, [1, 37]);
  for (const key of ['personality', 'design']) {
    for (const values of [null, '37, 40', {}, [0], [65], [-1], [1.5], ['37'], [NaN], [Infinity]]) {
      assert.throws(() => validateChart(exampleChart({ [key]: values })), Error);
    }
  }
});

test('import rejects malformed JSON, foreign formats, unsupported versions, and missing cards', () => {
  for (const text of [
    '{invalid', 'null', '[]', '{}',
    JSON.stringify({ format: 'another-format', version: 1, chart: exampleChart() }),
    JSON.stringify({ format: 'liniya-chart', version: 2, chart: exampleChart() }),
    JSON.stringify({ format: 'liniya-chart', version: 1 }),
    JSON.stringify({ format: 'liniya-chart', version: 1, chart: [] })
  ]) {
    assert.throws(() => decodeChart(text), Error);
  }
});

test('chart and import limits reject oversized input; bounded note fields are trimmed', () => {
  assert.throws(() => decodeChart(' '.repeat(100001)), /большой/);
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
  for (const content of ['{invalid', '{}', JSON.stringify(Array(501).fill(exampleChart()))]) {
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

test('gate selection highlights its connected gate and complete channel without losing the other gates', () => {
  const markup = renderBodygraph({ personality: [37], design: [40] }, { type: 'gate', id: 37 });
  const gates = new Map(interactiveGroups(markup, 'gate').map(group => [group.id, group.attributes]));
  assert.equal(gates.size, 64);
  assert.match(gates.get('37'), /aria-pressed="true"/);
  assert.match(gates.get('37'), /data-related="true"/);
  assert.match(gates.get('40'), /data-related="true"/);
  assert.match(gates.get('40'), /aria-pressed="false"/);
  const channel = interactiveGroups(markup, 'channel').find(group => group.id === '37-40');
  assert.match(channel.attributes, /data-defined="true"/);
  assert.match(channel.attributes, /data-related="true"/);
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

test('calculated chart export/import retains both activation streams and calculation provenance', () => {
  const original = calculatedChart();
  const roundtrip = decodeChart(encodeChart(original));
  for (const key of ['source', 'personality', 'design', 'activations', 'timezone', 'utc', 'utcOffset', 'fold', 'designUtc', 'cityId', 'city', 'engine', 'ephemeris', 'timezoneDatabase', 'nodeModel', 'zodiac', 'designArcResidualDegrees', 'verification']) {
    assert.deepEqual(roundtrip[key], original[key], `preserve ${key}`);
  }
  assert.deepEqual(decodeChart(encodeChart(roundtrip)), roundtrip, 'repeated saves remain stable');
});

test('transit chart export/import keeps its source and absence of design activations', () => {
  const original = calculatedChart();
  Object.assign(original, {
    source: 'transit', name: 'Текущий момент', design: [], designUtc: null, designArcResidualDegrees: null,
    city: null, cityId: null, timezone: 'UTC', utcOffset: 'UTC+00:00'
  });
  original.activations.design = [];
  const roundtrip = decodeChart(encodeChart(original));
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

test('calculated chart import rejects duplicate planets and gates inconsistent with activation details', () => {
  const duplicate = calculatedChart();
  duplicate.activations.personality[1] = { ...duplicate.activations.personality[0] };
  assert.throws(() => validateChart(duplicate), Error);
  const inconsistent = calculatedChart();
  inconsistent.personality = [1];
  assert.throws(() => validateChart(inconsistent), Error);
});
