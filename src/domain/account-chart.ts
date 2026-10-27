import { isChartIdentifier as identifier, canonicalChartId } from '../../shared/chart-record-contract.ts';
import type { AccountChart, PublicAccountChart } from '../../shared/chart-record-contract.ts';
import type { Activation, City } from '../../shared/chart-types.ts';
import { validChartCalculationResult } from '../../shared/calculation-result.ts';
import { utcMilliseconds } from '../../shared/utc-format.ts';
import { SUPPORTED_START, SUPPORTED_END_EXCLUSIVE } from '../../shared/date-limits.ts';

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

const positive = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
const text = (value: unknown, max = Infinity): value is string => typeof value === 'string' && value.length <= max;
const nonempty = (value: unknown, max = Infinity): value is string => text(value, max) && !!value.trim();
const invalid = () => new TypeError('invalid_chart');

// One contract for network responses and the account library on this device.
function city(value: unknown): City {
  if (!object(value) || !(text(value.id, 40) || typeof value.id === 'number' && Number.isSafeInteger(value.id))
    || !nonempty(value.name, 160) || !text(value.country) || !text(value.region) || !nonempty(value.timezone)
    || typeof value.latitude !== 'number' || !Number.isFinite(value.latitude) || Math.abs(value.latitude) > 90
    || typeof value.longitude !== 'number' || !Number.isFinite(value.longitude) || Math.abs(value.longitude) > 180) throw invalid();
  return {id: value.id, name: value.name, country: value.country, region: value.region, timezone: value.timezone,
    latitude: value.latitude, longitude: value.longitude};
}
function chart(value: unknown): PublicAccountChart {
  if (!object(value) || !identifier(value.id) || !positive(value.revision) || !nonempty(value.name, 80)
    || (value.source !== 'calculated' && value.source !== 'transit')
    || !text(value.birthDate) || !/^\d{4}-\d{2}-\d{2}$/.test(value.birthDate)
    || !Number.isFinite(utcMilliseconds(value.birthDate + 'T00:00:00Z'))
    || !text(value.birthTime) || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value.birthTime)
    || !text(value.birthPlace) || !nonempty(value.calculationVersion)
    || !object(value.activations) || !validChartCalculationResult({chart:value})) throw invalid();
  const utc = utcMilliseconds(value.utc), design = utcMilliseconds(value.designUtc);
  if (!Number.isFinite(utc) || utc < SUPPORTED_START || utc >= SUPPORTED_END_EXCLUSIVE
    || !Number.isFinite(design) || design >= utc || !nonempty(value.timezone)
    || !text(value.utcOffset) || !/^UTC[+−-]\d{2}:\d{2}(?::\d{2})?$/.test(value.utcOffset)
    || value.fold !== 0 && value.fold !== 1
    || typeof value.designArcResidualDegrees !== 'number' || !Number.isFinite(value.designArcResidualDegrees)
    || value.designArcResidualDegrees < 0 || value.designArcResidualDegrees > 1e-7) throw invalid();
  for (const key of ['engine','ephemeris','timezoneDatabase','nodeModel','zodiac'] as const) {
    if (!nonempty(value[key], 500)) throw invalid();
  }
  if (!text(value.verification, 1000)) throw invalid();
  const location = value.source === 'calculated' ? city(value.city) : null;
  if (location ? String(value.cityId) !== String(location.id) || value.timezone !== location.timezone
    : value.city !== null || value.cityId !== null || value.timezone !== 'UTC') throw invalid();
  const side = (entries: unknown) => (entries as Activation[]).map(({planet, longitude, gate, line}) => ({planet, longitude, gate, line}));
  return {id: canonicalChartId(value.id), revision: value.revision, name: value.name, source: value.source,
    birthDate: value.birthDate, birthTime: value.birthTime, birthPlace: value.birthPlace,
    utc: value.utc as string, timezone: value.timezone, utcOffset: value.utcOffset, fold: value.fold,
    designUtc: value.designUtc as string, designArcResidualDegrees: value.designArcResidualDegrees,
    personality: [...value.personality as number[]], design: [...value.design as number[]],
    activations: {personality: side(value.activations.personality), design: side(value.activations.design)},
    cityId: location?.id ?? null, city: location, calculationVersion: value.calculationVersion,
    engine: value.engine as string, ephemeris: value.ephemeris as string, timezoneDatabase: value.timezoneDatabase as string,
    nodeModel: value.nodeModel as string, zodiac: value.zodiac as string, verification: value.verification};
}
export function validateAccountChart(value: unknown, expectedAccountId: string): AccountChart {
  const base = chart(value);
  if (!object(value) || value.accountId !== expectedAccountId || !text(value.note, 2000)
    || !positive(value.noteRevision) || !positive(value.publicRevision)
    || value.noteRevision > base.revision || value.publicRevision > base.revision) throw invalid();
  return {...base, accountId: expectedAccountId, note: value.note, noteRevision: value.noteRevision, publicRevision: value.publicRevision};
}

export function validatePublicAccountChart(value: unknown): PublicAccountChart {
  if (!object(value) || ['note','accountId','noteRevision','publicRevision'].some(key => key in value)) throw invalid();
  return chart(value);
}
