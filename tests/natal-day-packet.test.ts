import test from 'node:test';
// Invalid scalar inputs and edited headers intentionally cross runtime validation unchanged.
import assert from 'node:assert/strict';
import { encodeNatalDay } from '../server/packets/encode.ts';
import { decodeNatalDay } from '../shared/day-packets/decode.ts';
import { natalDayMinute, natalDayIndexAt, chartAtMinute } from '../src/domain/natal-day.ts';
import { normalizeTemporaryChart } from '../src/domain/temporary-chart.ts';
import { libraryRecordAtMinute } from './fixtures/natal-day.ts';

export function makeDay(date = '1990-06-15', timezone = 'UTC', samples = 1440) {
  return { date, timezone, startUtc: `${date}T00:00:00Z`, stepSeconds: 60, samples,
    segments: [{ index: 0, startUtc: `${date}T00:00:00Z`, offsetSeconds: 0, utcOffset: 'UTC+00:00', fold: 0 }],
    columns: Array.from({ length: 24 }, (_, column) => Array.from({ length: samples }, (_, minute) => column < 22 ? (10 + column * 15 + minute / 10000) % 360 : column === 22 ? Date.parse(`${date}T00:00:00Z`) / 1000 - 88 * 86400 + minute * 61 : (minute % 100) * 1e-12)),
    engine: 'Swiss Ephemeris test', ephemeris: 'Test ephemerides', timezoneDatabase: 'IANA test', nodeModel: 'true', zodiac: 'tropical-geocentric-apparent' };
}
const bits = (values:ArrayLike<number>) => Buffer.from(new Float64Array(values).buffer).toString('hex');
type PacketHeader = ReturnType<typeof makeDay> & {version:string;orders:number[];calculationVersion:string|number};
function rewriteHeader(packet:Uint8Array, update:(header:PacketHeader)=>void) {
  const length = new DataView(packet.buffer, packet.byteOffset).getUint32(4, true);
  const header = JSON.parse(new TextDecoder().decode(packet.subarray(8, 8 + length))) as PacketHeader;
  update(header);
  const next = new TextEncoder().encode(JSON.stringify(header)), result = new Uint8Array(packet.length - length + next.length);
  result.set(packet.subarray(0, 4)); new DataView(result.buffer).setUint32(4, next.length, true);
  result.set(next, 8); result.set(packet.subarray(8 + length), 8 + next.length);
  return result;
}

test('stored natal packets retain the full ephemeris range beyond new-chart admission', () => {
  for (const date of ['1801-01-01', '2299-12-31', '2300-01-01', '2399-12-31'] as const) {
    const day = makeDay(date, 'UTC', 1);
    assert.equal(decodeNatalDay(encodeNatalDay(day)).date, date);
  }
  const packet = encodeNatalDay(makeDay('2000-01-01', 'UTC', 1));
  for (const date of ['1800-12-31', '2400-01-01'] as const) {
    const outside = rewriteHeader(packet, (header:Pick<ReturnType<typeof makeDay>,'date'|'startUtc'|'segments'>) => {
      header.date = date;
      header.startUtc = `${date}T00:00:00Z`;
      header.segments[0].startUtc = header.startUtc;
    });
    assert.throws(() => decodeNatalDay(outside), { message: 'Некорректный пакет дня рождения.' });
  }
});

test('all predictors preserve every bit in both sides, design seconds and exact residuals', () => {
  const day = makeDay();
  day.columns[0].splice(0, 7, -0, 0, Number.MIN_VALUE, 307.62499999999994, 307.625, 359.99999999999994, 0.0000000000001);
  const expected = day.columns.map(bits);
  for (let order = 0; order < 5; order++) {
    const packet = encodeNatalDay(day, { orders: Array(24).fill(order) });
    assert.deepEqual(decodeNatalDay(packet).columns.map(bits), expected);
  }
  assert.deepEqual(day.columns.map(bits), expected);
});

test('historical seconds and repeated folds preserve unique sample instants without browser tzdata', () => {
  const day = makeDay('2024-11-03', 'America/New_York', 1500);
  day.startUtc = '2024-11-03T04:00:00Z';
  day.segments = [
    { index: 0, startUtc: day.startUtc, offsetSeconds: -14400, utcOffset: 'UTC−04:00', fold: 0 },
    { index: 120, startUtc: '2024-11-03T06:00:00Z', offsetSeconds: -18000, utcOffset: 'UTC−05:00', fold: 1 },
    { index: 180, startUtc: '2024-11-03T07:00:00Z', offsetSeconds: -18000, utcOffset: 'UTC−05:00', fold: 0 },
  ];
  const decoded = decodeNatalDay(encodeNatalDay(day));
  assert.deepEqual(natalDayMinute(decoded, 90), { index: 90, utc: '2024-11-03T05:30:00Z', localTime: '01:30', utcOffset: 'UTC−04:00', fold: 0 });
  assert.deepEqual(natalDayMinute(decoded, 150), { index: 150, utc: '2024-11-03T06:30:00Z', localTime: '01:30', utcOffset: 'UTC−05:00', fold: 1 });
  assert.equal(natalDayIndexAt(decoded, '2024-11-03T06:30:45Z'), 150);
  assert.equal(natalDayIndexAt(decoded, 0), 0);
  assert.equal(natalDayIndexAt(decoded, Date.parse('2025-01-01')), 1499);
  const historical = makeDay('1900-01-01', 'Europe/Paris');
  historical.startUtc = '1899-12-31T23:50:39Z';
  historical.segments = [{ index: 0, startUtc: historical.startUtc, offsetSeconds: 561, utcOffset: 'UTC+00:09:21', fold: 0 }];
  assert.equal(natalDayMinute(decodeNatalDay(encodeNatalDay(historical)), 1).utc, '1899-12-31T23:51:39Z');
});

test('minute lookup keeps exact second boundaries, gaps and endpoint clamping', () => {
  const day = makeDay('1900-01-01', 'Europe/Paris', 4);
  day.startUtc = '1899-12-31T23:50:39Z';
  day.segments = [
    { index: 0, startUtc: day.startUtc, offsetSeconds: 561, utcOffset: 'UTC+00:09:21', fold: 0 },
    { index: 2, startUtc: '1899-12-31T23:54:39Z', offsetSeconds: 561, utcOffset: 'UTC+00:09:21', fold: 0 },
  ];
  const decoded = decodeNatalDay(encodeNatalDay(day));
  for (const [utc, index] of [
    ['1899-12-31T23:49:00Z', 0], ['1899-12-31T23:50:38.999Z', 0],
    ['1899-12-31T23:50:39Z', 0], ['1899-12-31T23:51:38.999Z', 0],
    ['1899-12-31T23:51:39Z', 1], ['1899-12-31T23:54:38.999Z', 1],
    ['1899-12-31T23:54:39Z', 2], ['1899-12-31T23:55:38.999Z', 2],
    ['1899-12-31T23:55:39Z', 3], ['1900-01-02T00:00:00Z', 3],
  ] as const) {
    assert.equal(natalDayIndexAt(decoded, utc), index, utc);
    assert.equal(natalDayIndexAt(decoded, Date.parse(utc)), index, `numeric ${utc}`);
  }
  for (const invalid of [undefined, null, '', 'invalid', NaN, Infinity] as const) assert.equal(natalDayIndexAt(decoded, invalid as string|number), 0);
  for (const invalid of [-1, 4, 0.5, '1', NaN, Infinity] as const) {
    assert.throws(() => natalDayMinute(decoded, invalid as number), /Некорректный пакет дня рождения/);
  }
});

test('materialization contains only chart data and an explicit saved record retains its separate identity', () => {
  const day = decodeNatalDay(encodeNatalDay(makeDay()));
  const original = Object.freeze({ id: 'saved-id', name: 'My chart', note: 'Keep', createdAt: 'original', updatedAt: 'original', cityId: '123' });
  const chart = chartAtMinute(day, 41);
  for (const key of ['id', 'name', 'note', 'createdAt', 'updatedAt', 'cityId', 'birthDate', 'birthTime'] as const) assert.equal(Object.hasOwn(chart, key), false);
  assert.equal(chart.localDate, day.date); assert.equal(chart.localTime, '00:41');
  assert.equal(chart.activations.personality.length, 13); assert.equal(chart.activations.design.length, 13);
  assert.equal(chart.designArcResidualDegrees, day.columns[23][41]);
  const record = libraryRecordAtMinute(day, 41, original as unknown as Parameters<typeof libraryRecordAtMinute>[2]);
  assert.equal(record.id, original.id); assert.equal(record.name, original.name); assert.equal(record.note, original.note);
  assert.equal(record.createdAt, original.createdAt); assert.equal(record.updatedAt, original.updatedAt);
  assert.equal(record.birthTime, chart.localTime); assert.deepEqual(record.activations, chart.activations);
  assert.equal(normalizeTemporaryChart(record)?.utc, chart.utc);
  assert.equal(Reflect.get(original,'birthTime'), undefined);
  for (const bad of [-1, 1440, 0.5, '1', NaN] as const) assert.throws(() => chartAtMinute(day, bad as number));
});

test('bounded shapes, timeline validation and value ranges reject corrupt packets', () => {
  const packet = encodeNatalDay(makeDay());
  for (const bad of [null, {}, packet.subarray(0, -1), new Uint8Array(1_000_000)] as const) assert.throws(() => decodeNatalDay(bad));
  for (const update of [(h: { version: string; }) => h.version = '2', (h:PacketHeader) => h.calculationVersion = '', (h:PacketHeader) => h.calculationVersion = 123, (h:PacketHeader) => h.calculationVersion = 'g'.repeat(64), (h: { samples: number; }) => h.samples = 2881, (h: { samples: number; }) => h.samples = 0, (h:{orders:number[]}) => h.orders.pop(), (h: { orders: number[]; }) => h.orders[0] = 9,
    (    h: { segments: { index: number; }[]; }) => h.segments[0].index = 1, (h: { segments: { offsetSeconds: number; }[]; }) => h.segments[0].offsetSeconds = 1, (h: { segments: { fold: number; }[]; }) => h.segments[0].fold = 2,
    (    h: { segments: { startUtc: string; }[]; }) => h.segments[0].startUtc = '2000-01-01T00:00:00Z', (h: { date: string; }) => h.date = '1990-02-30', (h: { timezone: string; }) => h.timezone = 'x'.repeat(161)] as const) {
    assert.throws(() => decodeNatalDay(rewriteHeader(packet, update)));
  }
  for (const [column, value] of [[0, NaN], [21, 360], [22, 1.5], [23, 1e-6]] as const) {
    const day = makeDay(); day.columns[column][0] = value; assert.throws(() => encodeNatalDay(day));
  }
});

test('natal packet validation visits holes once instead of scanning dense values twice', () => {
  const day = makeDay(); let reads = 0;
  day.columns[0] = new Proxy(day.columns[0], { get(target, key, receiver) {
    if (typeof key === 'string' && /^\d+$/.test(key)) reads++;
    return Reflect.get(target, key, receiver);
  } });
  encodeNatalDay(day);
  assert.equal(reads, 1440 * 2);
  const sparse = makeDay(); delete sparse.columns[0][12];
  assert.throws(() => encodeNatalDay(sparse));
  const missing = makeDay(); delete missing.columns[0];
  assert.throws(() => encodeNatalDay(missing));
});
