import { gatePositionAtLongitude } from './gate-wheel.js';
import { PLANET_IDS } from './planets.js';
import { LIFETIME_PLANETS, LIFETIME_STEP_SECONDS } from '../../shared/lifetime-format.js';

export { LIFETIME_PLANETS } from '../../shared/lifetime-format.js';
const fail = () => { throw new Error('Некорректные данные шкалы лет.'); };
const utcText = milliseconds => new Date(milliseconds).toISOString().replace('.000Z', 'Z');
// Only snapshots made here can skip repeated validation. Weak references do not
// keep visited dates alive, and a moment is trusted only for its own metadata.
const validatedMetadata = new WeakSet();
const validatedMoments = new WeakMap();
const validLongitudes = values => Array.isArray(values) && values.length === LIFETIME_PLANETS.length
  && LIFETIME_PLANETS.every((_, index) => Number.isFinite(values[index]) && values[index] >= 0 && values[index] < 360);

export function validateLifetimeMetadata(value) {
  if (validatedMetadata.has(value)) return value;
  const start = Date.parse(value?.startUtc), end = Date.parse(value?.endExclusiveUtc);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start
      || value.startUtc !== utcText(start) || value.endExclusiveUtc !== utcText(end)
      || value.stepSeconds !== LIFETIME_STEP_SECONDS || !Number.isSafeInteger(value.samples) || value.samples < 1
      || end - start !== value.samples * value.stepSeconds * 1000
      || !Array.isArray(value.planets) || value.planets.length !== LIFETIME_PLANETS.length
      || LIFETIME_PLANETS.some((planet, index) => planet !== value.planets[index])) return fail();
  const metadata = Object.freeze({ ...value, startUtc: value.startUtc, endExclusiveUtc: value.endExclusiveUtc,
    stepSeconds: value.stepSeconds, samples: value.samples, planets: Object.freeze([...value.planets]) });
  validatedMetadata.add(metadata);
  return metadata;
}

export function validateLifetimePoint(value, metadata, expectedIndex = value?.index) {
  if (!Number.isInteger(expectedIndex) || expectedIndex < 0 || expectedIndex >= metadata.samples
      || value?.index !== expectedIndex || !validLongitudes(value.longitudes)) return fail();
  const milliseconds = Date.parse(metadata.startUtc) + expectedIndex * metadata.stepSeconds * 1000;
  const utc = utcText(milliseconds);
  if (value.utc !== utc && value.utc !== new Date(milliseconds).toISOString()) return fail();
  return Object.freeze({ index: expectedIndex, utc, longitudes: Object.freeze([...value.longitudes]) });
}

export function lifetimeChartAt(metadata, point) {
  metadata = validateLifetimeMetadata(metadata);
  point = point?.design ? validateLifetimeMoment(point, metadata) : validateLifetimePoint(point, metadata);
  const values = Object.fromEntries(metadata.planets.map((planet, index) => [planet, point.longitudes[index]]));
  values.earth = (values.sun + 180) % 360;
  values.south_node = (values.north_node + 180) % 360;
  const personality = PLANET_IDS.filter(planet => Object.prototype.hasOwnProperty.call(values, planet))
    .map(planet => ({ planet, ...gatePositionAtLongitude(values[planet]) }));
  const utc = point.utc;
  const chart = { id: 'lifetime-preview', name: 'Транзит', source: 'transit',
    personality: [...new Set(personality.map(entry => entry.gate))].sort((a, b) => a - b), design: [],
    activations: { personality, design: [] }, utc, birthDate: utc.slice(0, 10), birthTime: utc.slice(11, 16),
    birthPlace: '', timezone: 'UTC', utcOffset: 'UTC+00:00', fold: 0, designUtc: null, cityId: null, city: null,
    engine: metadata.engine || metadata.source, ephemeris: metadata.ephemeris, timezoneDatabase: metadata.timezoneDatabase,
    nodeModel: metadata.nodeModel, zodiac: metadata.zodiac, designArcResidualDegrees: null,
    updatedAt: utc, createdAt: metadata.startUtc, note: '',
    verification: 'Exact Swiss Ephemeris longitudes on a ten-minute grid.' };
  return point.design ? attachDesign(chart, point.design) : chart;
}

export function validateLifetimeMoment(value, metadata, expectedIndex = value?.index) {
  metadata = validateLifetimeMetadata(metadata);
  if (validatedMoments.get(value) === metadata && value.index === expectedIndex) return value;
  const point = validateLifetimePoint(value, metadata, expectedIndex);
  const moment = Object.freeze({ ...point, design: validateLifetimeDesign(value?.design, point.utc) });
  validatedMoments.set(moment, metadata);
  return moment;
}

export function validateLifetimeDesign(value, expectedUtc) {
  const utc = Date.parse(expectedUtc), design = Date.parse(value?.designUtc);
  if (!Number.isFinite(utc) || Date.parse(value?.utc) !== utc || typeof value?.designUtc !== 'string' || !Number.isFinite(design)
      || design >= utc || design < utc - 110 * 86_400_000
      || !Number.isFinite(value?.designArcResidualDegrees) || Math.abs(value.designArcResidualDegrees) > 1e-7
      || !validLongitudes(value?.longitudes)) return fail();
  return Object.freeze({ utc: utcText(utc), designUtc: value.designUtc,
    designArcResidualDegrees: value.designArcResidualDegrees, longitudes: Object.freeze([...value.longitudes]) });
}

function attachDesign(chart, point) {
  const values = Object.fromEntries(LIFETIME_PLANETS.map((planet, index) => [planet, point.longitudes[index]]));
  values.earth = (values.sun + 180) % 360;
  values.south_node = (values.north_node + 180) % 360;
  const design = PLANET_IDS.map(planet => ({ planet, ...gatePositionAtLongitude(values[planet]) }));
  return { ...chart, activations: { ...chart.activations, design },
    design: [...new Set(design.map(entry => entry.gate))].sort((a, b) => a - b),
    designUtc: point.designUtc, designArcResidualDegrees: point.designArcResidualDegrees };
}
