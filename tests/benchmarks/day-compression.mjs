// Isolated experiment: real calculator inputs, reversible codecs, no app changes.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { gzipSync, gunzipSync, brotliCompressSync, brotliDecompressSync, constants } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { compareColumns, decodeColumns } from './day-compression-codecs.mjs';
import { gatePositionAtLongitude, normalizeLongitude } from '../../src/domain/gate-wheel.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const independent = ['sun', 'moon', 'north_node', 'mercury', 'venus', 'mars', 'jupiter', 'saturn', 'uranus', 'neptune', 'pluto'];
const planetOrder = ['sun', 'earth', 'moon', 'north_node', 'south_node', 'mercury', 'venus', 'mars', 'jupiter', 'saturn', 'uranus', 'neptune', 'pluto'];
const variableKeys = new Set(['utc', 'birthTime', 'utcOffset', 'fold', 'designUtc', 'designArcResidualDegrees', 'personality', 'design', 'activations']);
const fixtures = [
  ['1990-06-15', 'Europe/Moscow'], ['2000-02-29', 'UTC'], ['2026-09-24', 'UTC'],
  ['2024-03-10', 'America/New_York'], ['2024-11-03', 'America/New_York'],
  ['2026-10-04', 'Australia/Lord_Howe'], ['1900-01-01', 'Europe/Paris'],
];

function ieee(value) { const bytes = Buffer.alloc(8); bytes.writeDoubleLE(value); return bytes.toString('hex'); }
function iso(seconds) { return new Date(seconds * 1000).toISOString().replace('.000Z', 'Z'); }
function activation(planet, longitude) {
  const { gate, line } = gatePositionAtLongitude(longitude);
  return { planet, longitude, gate, line };
}
function materialize(columns, index, source, names) {
  const values = Object.fromEntries(independent.map(planet => [planet, columns[names.indexOf(`${source}.${planet}`)][index]]));
  values.earth = (values.sun + 180) % 360;
  values.south_node = (values.north_node + 180) % 360;
  return planetOrder.map(planet => activation(planet, values[planet]));
}
function encodeInput(dataset, kind) {
  const charts = dataset[kind];
  const sources = kind === 'natal' ? ['personality', 'design'] : ['personality'];
  const names = sources.flatMap(source => independent.map(planet => `${source}.${planet}`));
  const columns = names.map(name => {
    const [source, planet] = name.split('.');
    return charts.map(chart => chart.activations[source].find(a => a.planet === planet).longitude);
  });
  if (kind === 'natal') {
    names.push('designUtc');
    columns.push(charts.map(chart => Date.parse(chart.designUtc) / 1000));
  }
  const transitions = [];
  charts.forEach((chart, index) => {
    if (kind === 'natal' && (!index || chart.utcOffset !== charts[index - 1].utcOffset || chart.fold !== charts[index - 1].fold)) {
      transitions.push({ index, utcOffset: chart.utcOffset, fold: chart.fold });
    }
  });
  const metadata = kind === 'natal'
    ? Object.fromEntries(Object.entries(charts[0]).filter(([key]) => !variableKeys.has(key)))
    : { source: 'transit', engine: dataset.natal[0].engine, ephemeris: dataset.natal[0].ephemeris,
        timezoneDatabase: dataset.natal[0].timezoneDatabase, nodeModel: 'true', zodiac: dataset.natal[0].zodiac };
  return { columns, header: { experiment: 'minute-day-lossless-v1', kind, names, metadata, transitions,
    startUtc: dataset.startUtc, date: dataset.date, timezone: dataset.timezone, samples: dataset.samples, stepSeconds: 60 } };
}

function verifyDerived(dataset, kind, columns, header) {
  let checked = 0;
  dataset[kind].forEach((chart, index) => {
    const personality = materialize(columns, index, 'personality', header.names);
    const design = kind === 'natal' ? materialize(columns, index, 'design', header.names) : [];
    for (const [source, values] of [['personality', personality], ['design', design]]) {
      assert.deepEqual(values, chart.activations[source]);
      values.forEach((value, i) => { assert.equal(ieee(value.longitude), ieee(chart.activations[source][i].longitude)); checked++; });
    }
    assert.equal(iso(Date.parse(header.startUtc) / 1000 + index * 60), chart.utc);
    if (kind !== 'natal') return;
    assert.deepEqual([...new Set(personality.map(a => a.gate))].sort((a, b) => a - b), chart.personality);
    assert.deepEqual([...new Set(design.map(a => a.gate))].sort((a, b) => a - b), chart.design);
    assert.equal(iso(columns[header.names.indexOf('designUtc')][index]), chart.designUtc);
    const residual = Math.abs(normalizeLongitude(personality[0].longitude - design[0].longitude) - 88);
    assert.equal(ieee(residual), ieee(chart.designArcResidualDegrees));
    const transition = header.transitions.findLast(item => item.index <= index);
    assert.equal(transition.utcOffset, chart.utcOffset);
    assert.equal(transition.fold, chart.fold);
    // The local clock comes from the stored offset, never the viewer's timezone.
    const match = transition.utcOffset.match(/^UTC([+−])(\d+):(\d+)(?::(\d+))?$/);
    const offset = (match[1] === '+' ? 1 : -1) * (+match[2] * 3600 + +match[3] * 60 + +(match[4] || 0));
    assert.equal(new Date(Date.parse(chart.utc) + offset * 1000).toISOString().slice(11, 16), chart.birthTime);
    for (const [key, value] of Object.entries(header.metadata)) assert.deepEqual(value, chart[key]);
  });
  return checked;
}

function compress(bytes, compression) {
  if (compression === 'none') return bytes;
  const level = Number(compression.split('-')[1]);
  return compression.startsWith('gzip') ? gzipSync(bytes, { level })
    : brotliCompressSync(bytes, { params: { [constants.BROTLI_PARAM_QUALITY]: level } });
}
function decompress(bytes, compression) {
  if (compression === 'none') return bytes;
  return compression.startsWith('gzip') ? gunzipSync(bytes) : brotliDecompressSync(bytes);
}
function framedPacket(columns, header, candidate) {
  // One normal transport compression over metadata AND transformed numbers.
  // Gzip is browser HTTP-compatible too; no in-browser Brotli dependency implied.
  const numeric = compareColumns(columns, { transforms: [candidate.transform], gzipLevels: [], brotliQualities: [], iterations: 1, includeBuffer: true }).best.buffer;
  const metadata = Buffer.from(JSON.stringify(header));
  const packet = Buffer.concat([Buffer.from('FDB1'), Buffer.alloc(4), metadata, numeric]);
  packet.writeUInt32LE(metadata.length, 4);
  const compressed = compress(packet, candidate.compression);
  const unpacked = decompress(compressed, candidate.compression);
  assert.ok(packet.equals(unpacked));
  assert.equal(unpacked.toString('ascii', 0, 4), 'FDB1');
  const offset = 8 + unpacked.readUInt32LE(4);
  const restoredHeader = JSON.parse(unpacked.subarray(8, offset));
  assert.deepEqual(restoredHeader, header);
  const decoded = decodeColumns(unpacked.subarray(offset), 'none');
  return { bytes: compressed.length, metadataBytes: metadata.length + 8, decoded };
}

const results = [];
for (const [date, timezone] of process.argv.includes('--quick') ? fixtures.slice(0, 1) : fixtures) {
  const dataset = JSON.parse(execFileSync(`${root}.venv/bin/python`, [`${root}tests/benchmarks/day-compression-samples.py`, date, timezone], { cwd: root, maxBuffer: 32 * 1024 * 1024 }));
  for (const kind of ['transit', 'natal']) {
    const { columns, header } = encodeInput(dataset, kind);
    const comparison = compareColumns(columns, { iterations: 1, gzipLevels: [6, 9], brotliQualities: [4, 9, 11] });
    const packet = framedPacket(columns, header, comparison.best);
    const gzipBest = comparison.candidates.find(candidate => candidate.compression.startsWith('gzip'));
    const gzipPacket = framedPacket(columns, header, gzipBest);
    const exactActivationValues = verifyDerived(dataset, kind, packet.decoded, header);
    verifyDerived(dataset, kind, gzipPacket.decoded, header);
    const plainJSON = Buffer.from(JSON.stringify(dataset[kind]));
    const result = { date, timezone, kind, samples: dataset.samples,
      calculationMs: dataset[`${kind}CalculationMs`], fullJSONBytes: plainJSON.length,
      fullJSONGzipBytes: gzipSync(plainJSON, { level: 9 }).length,
      numericBytes: comparison.rawBytes, metadataBytesBeforeCompression: packet.metadataBytes,
      packetBytes: packet.bytes, codec: comparison.best.codec,
      gzipPacketBytes: gzipPacket.bytes, gzipCodec: gzipBest.codec,
      exactActivationValues, candidates: comparison.candidates };
    results.push(result);
    process.stdout.write(JSON.stringify({ ...result, candidates: result.candidates.slice(0, 5) }) + '\n');
  }
}
if (process.argv.includes('--report')) {
  const path = process.argv[process.argv.indexOf('--report') + 1];
  if (!path) throw new Error('A report path is required');
  writeFileSync(path, JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2));
}
