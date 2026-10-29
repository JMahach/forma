import type { LifetimeMetadata } from '../../shared/lifetime-format.ts';
import type { DesignMoment } from '../../shared/day-packets/moment-columns.ts';
import type { ChartData } from '../../shared/chart-types.ts';
export interface LifetimePoint { index: number; utc: string; longitudes: readonly number[]; design?: DesignMoment }
interface ExactPoint { version: string; utc: string; longitudes: readonly number[]; design: DesignMoment }
import { projectMomentChart, snapshotLongitudes } from './moment-projection.ts';
import { LIFETIME_PLANETS, LIFETIME_STEP_SECONDS } from '../../shared/lifetime-format.ts';
import { LIFETIME_EXACT_VERSION } from '../../shared/lifetime-exact-format.ts';

const fail = (): never => { throw new Error('Некорректные данные летописи.'); };
const utcText = (milliseconds: number) => new Date(milliseconds).toISOString().replace('.000Z', 'Z');
// Only snapshots made here can skip repeated validation. Weak references do not
// keep visited dates alive, and a moment is trusted only for its own metadata.
const validatedMetadata = new WeakSet<LifetimeMetadata>();
const validatedMoments = new WeakMap<object, LifetimeMetadata>();
const validatedPoints = new WeakMap<object, LifetimeMetadata>(), projectedCharts = new WeakMap<object, Readonly<ChartData>>();
const validLongitudes = (values: unknown): values is number[] => Array.isArray(values) && values.length === LIFETIME_PLANETS.length
  && LIFETIME_PLANETS.every((_, index) => Number.isFinite(values[index]) && values[index] >= 0 && values[index] < 360);

export function validateLifetimeMetadata(input: unknown): Readonly<LifetimeMetadata> {
  const value = input as LifetimeMetadata;
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

function validateLifetimePoint(value: LifetimePoint, metadata: LifetimeMetadata, expectedIndex = value?.index): Readonly<LifetimePoint> {
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

export function lifetimeChartAt(metadata: LifetimeMetadata, point: LifetimePoint) {
  metadata = validateLifetimeMetadata(metadata);
  point = point?.design ? validateLifetimeMoment(point, metadata) : validateLifetimePoint(point, metadata);
  if (projectedCharts.has(point)) return projectedCharts.get(point)!;
  const chart = projectMomentChart(point, metadata.planets, {
    engine: metadata.engine, ephemeris: metadata.ephemeris, timezoneDatabase: metadata.timezoneDatabase,
    nodeModel: metadata.nodeModel, zodiac: metadata.zodiac,
    verification: 'Exact Swiss Ephemeris longitudes on a ten-minute grid.' });
  projectedCharts.set(point, chart);
  return chart;
}

export function validateLifetimeMoment(input: unknown, metadata: LifetimeMetadata, expectedIndex = (input as LifetimePoint)?.index) {
  const value = input as LifetimePoint;
  metadata = validateLifetimeMetadata(metadata);
  if (validatedMoments.get(value) === metadata && value.index === expectedIndex) return value;
  const point = validateLifetimePoint(value, metadata, expectedIndex);
  const moment = Object.freeze({ ...point, design: validateLifetimeDesign(value?.design, point.utc) });
  validatedMoments.set(moment, metadata);
  return moment;
}

// A precise UTC result is not a lifetime index. Keep both timestamps and all
// Float64 values; projection derives the same 26 activations as Day and Lifetime.
export function lifetimeExactChartAt(input: unknown, metadata: LifetimeMetadata, milliseconds: number) {
  const value = input as ExactPoint;
  metadata = validateLifetimeMetadata(metadata);
  if (!Number.isSafeInteger(milliseconds) || milliseconds < Date.parse(metadata.startUtc)
      || milliseconds >= Date.parse(metadata.endExclusiveUtc) || value?.version !== LIFETIME_EXACT_VERSION
      || value.utc !== utcText(milliseconds) || !validLongitudes(value.longitudes)) return fail();
  const moment = Object.freeze({ utc: value.utc, longitudes: snapshotLongitudes(value.longitudes),
    design: validateLifetimeDesign(value.design, value.utc) });
  return projectMomentChart(moment, metadata.planets, {
    engine: metadata.engine, ephemeris: metadata.ephemeris, timezoneDatabase: metadata.timezoneDatabase,
    nodeModel: metadata.nodeModel, zodiac: metadata.zodiac,
    verification: 'Exact Swiss Ephemeris longitudes for the selected UTC instant.' });
}

function validateLifetimeDesign(input: unknown, expectedUtc: string): Readonly<DesignMoment> {
  const value = input as DesignMoment;
  const utc = Date.parse(expectedUtc), design = Date.parse(value?.designUtc);
  if (!Number.isFinite(utc) || Date.parse(value?.utc) !== utc || typeof value?.designUtc !== 'string' || !Number.isFinite(design)
      || design >= utc || design < utc - 110 * 86_400_000
      || !Number.isFinite(value?.designArcResidualDegrees) || value.designArcResidualDegrees < 0 || value.designArcResidualDegrees > 1e-7
      || !validLongitudes(value?.longitudes)) return fail();
  return Object.freeze({ utc: utcText(utc), designUtc: value.designUtc,
    designArcResidualDegrees: value.designArcResidualDegrees, longitudes: snapshotLongitudes(value.longitudes) });
}
