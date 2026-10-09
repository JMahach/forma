import { projectMomentChart, snapshotLongitudes } from './moment-projection.js';
import { LIFETIME_PLANETS, LIFETIME_STEP_SECONDS, LIFETIME_EXACT_VERSION } from '../../shared/lifetime-format.js';

const fail = () => { throw new Error('Некорректные данные летописи.'); };
const utcText = milliseconds => new Date(milliseconds).toISOString().replace('.000Z', 'Z');
// Only snapshots made here can skip repeated validation. Weak references do not
// keep visited dates alive, and a moment is trusted only for its own metadata.
const validatedMetadata = new WeakSet();
const validatedMoments = new WeakMap();
const validatedPoints = new WeakMap(), projectedCharts = new WeakMap();
const validLongitudes = values => Array.isArray(values) && values.length === LIFETIME_PLANETS.length
  && LIFETIME_PLANETS.every((_, index) => Number.isFinite(values[index]) && values[index] >= 0 && values[index] < 360);

export function validateLifetimeMetadata(value) {
  if (validatedMetadata.has(value)) return value;
  const start = Date.parse(value?.startUtc), end = Date.parse(value?.endExclusiveUtc);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start
      || value.startUtc !== utcText(start) || value.endExclusiveUtc !== utcText(end)
      || value.stepSeconds !== LIFETIME_STEP_SECONDS || !Number.isSafeInteger(value.samples) || value.samples < 1
      || end - start !== value.samples * value.stepSeconds * 1000
      || value.calculationVersion !== undefined && (typeof value.calculationVersion !== 'string' || !/^[a-f0-9]{64}$/.test(value.calculationVersion))
      || value.cacheVersion !== undefined && (typeof value.cacheVersion !== 'string' || !/^[a-f0-9]{64}$/.test(value.cacheVersion))
      || !Array.isArray(value.planets) || value.planets.length !== LIFETIME_PLANETS.length
      || LIFETIME_PLANETS.some((planet, index) => planet !== value.planets[index])) return fail();
  const metadata = Object.freeze({ ...value, startUtc: value.startUtc, endExclusiveUtc: value.endExclusiveUtc,
    stepSeconds: value.stepSeconds, samples: value.samples, planets: Object.freeze([...value.planets]) });
  validatedMetadata.add(metadata);
  return metadata;
}

function validateLifetimePoint(value, metadata, expectedIndex = value?.index) {
  metadata = validateLifetimeMetadata(metadata);
  if (validatedPoints.get(value) === metadata && value.index === expectedIndex) return value;
  if (!Number.isInteger(expectedIndex) || expectedIndex < 0 || expectedIndex >= metadata.samples
      || value?.index !== expectedIndex || !validLongitudes(value.longitudes)) return fail();
  const milliseconds = Date.parse(metadata.startUtc) + expectedIndex * metadata.stepSeconds * 1000;
  const utc = utcText(milliseconds);
  if (value.utc !== utc && value.utc !== new Date(milliseconds).toISOString()) return fail();
  const point = Object.freeze({ index: expectedIndex, utc, longitudes: snapshotLongitudes(value.longitudes) });
  validatedPoints.set(point, metadata);
  return point;
}

export function lifetimeChartAt(metadata, point) {
  metadata = validateLifetimeMetadata(metadata);
  point = point?.design ? validateLifetimeMoment(point, metadata) : validateLifetimePoint(point, metadata);
  if (projectedCharts.has(point)) return projectedCharts.get(point);
  const chart = projectMomentChart(point, metadata.planets, { id: 'lifetime-preview', createdAt: metadata.startUtc,
    engine: metadata.engine, ephemeris: metadata.ephemeris, timezoneDatabase: metadata.timezoneDatabase,
    nodeModel: metadata.nodeModel, zodiac: metadata.zodiac,
    verification: 'Exact Swiss Ephemeris longitudes on a ten-minute grid.' });
  projectedCharts.set(point, chart);
  return chart;
}

export function validateLifetimeMoment(value, metadata, expectedIndex = value?.index) {
  metadata = validateLifetimeMetadata(metadata);
  if (validatedMoments.get(value) === metadata && value.index === expectedIndex) return value;
  const point = validateLifetimePoint(value, metadata, expectedIndex);
  const moment = Object.freeze({ ...point, design: validateLifetimeDesign(value?.design, point.utc) });
  validatedMoments.set(moment, metadata);
  return moment;
}

// A precise UTC result is not a lifetime index. Keep both timestamps and all
// Float64 values; projection derives the same 26 activations as Day and Lifetime.
export function lifetimeExactChartAt(value, metadata, milliseconds) {
  metadata = validateLifetimeMetadata(metadata);
  if (!Number.isSafeInteger(milliseconds) || milliseconds < Date.parse(metadata.startUtc)
      || milliseconds >= Date.parse(metadata.endExclusiveUtc) || value?.version !== LIFETIME_EXACT_VERSION
      || value.utc !== utcText(milliseconds) || !validLongitudes(value.longitudes)) return fail();
  const moment = Object.freeze({ utc: value.utc, longitudes: snapshotLongitudes(value.longitudes),
    design: validateLifetimeDesign(value.design, value.utc) });
  return projectMomentChart(moment, metadata.planets, { id: 'lifetime-preview', createdAt: metadata.startUtc,
    engine: metadata.engine, ephemeris: metadata.ephemeris, timezoneDatabase: metadata.timezoneDatabase,
    nodeModel: metadata.nodeModel, zodiac: metadata.zodiac,
    verification: 'Exact Swiss Ephemeris longitudes for the selected UTC instant.' });
}

function validateLifetimeDesign(value, expectedUtc) {
  const utc = Date.parse(expectedUtc), design = Date.parse(value?.designUtc);
  if (!Number.isFinite(utc) || Date.parse(value?.utc) !== utc || typeof value?.designUtc !== 'string' || !Number.isFinite(design)
      || design >= utc || design < utc - 110 * 86_400_000
      || !Number.isFinite(value?.designArcResidualDegrees) || value.designArcResidualDegrees < 0 || value.designArcResidualDegrees > 1e-7
      || !validLongitudes(value?.longitudes)) return fail();
  return Object.freeze({ utc: utcText(utc), designUtc: value.designUtc,
    designArcResidualDegrees: value.designArcResidualDegrees, longitudes: snapshotLongitudes(value.longitudes) });
}
