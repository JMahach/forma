import test from 'node:test';
import assert from 'node:assert/strict';
import { calendarTimelineTicks } from '../src/domain/timeline-ticks.js';

const utc = value => Date.parse(value);
const ticks = (from, to, width = 600, extra = {}) => calendarTimelineTicks({
  fromUtc: utc(from), toUtc: utc(to), width, ...extra,
});
function assertSpace(marks, width) {
  const interior = marks.filter(mark => !mark.edge);
  for (let index = 0; index < interior.length; index++) {
    const mark = interior[index];
    assert.ok(mark.position * width >= 12);
    assert.ok((1 - mark.position) * width >= 12);
    if (index) assert.ok((mark.position - interior[index - 1].position) * width >= 40 - 1e-7);
  }
}

test('three months crossing New Year use calendar months and exact inclusive endpoints', () => {
  const from = '2025-11-01T00:00:00Z', to = '2026-01-31T23:59:59.999Z';
  const marks = ticks(from, to);
  assert.deepEqual(marks[0], { utc: utc(from), position: 0, edge: 'start', unit: 'month', step: 1, gridIndex: 24310 });
  assert.deepEqual(marks.at(-1), { utc: utc(to), position: 1, edge: 'end', unit: 'month', step: 1, gridIndex: null });
  assert.deepEqual(marks.slice(1, -1).map(mark => new Date(mark.utc).toISOString().slice(0, 10)), ['2025-12-01', '2026-01-01']);
  assertSpace(marks, 600);
});

test('a multi-year interval has January boundaries', () => {
  const marks = ticks('2021-05-14T03:24:00Z', '2024-07-03T23:59:59.999Z');
  assert.deepEqual(marks.slice(1, -1).map(mark => new Date(mark.utc).getUTCFullYear()), [2022, 2023, 2024]);
  for (const mark of marks.slice(1, -1)) assert.match(new Date(mark.utc).toISOString(), /-01-01T00:00:00.000Z$/);
  assertSpace(marks, 600);
});

test('short calendar ranges include leap day without approximating months as thirty days', () => {
  const marks = ticks('2024-02-26T00:00:00Z', '2024-03-02T23:59:59.999Z', 900);
  assert.ok(marks.some(mark => mark.utc === utc('2024-02-29T00:00:00Z')));
  assert.ok(marks.some(mark => mark.utc === utc('2024-03-01T00:00:00Z')));
  assertSpace(marks, 900);
});

test('density follows available width and never exceeds twenty-four ticks', () => {
  for (const width of [90, 120, 240, 400, 1000, 10000]) {
    const marks = ticks('1998-08-18T14:00:00Z', '2098-08-18T23:59:59.999Z', width);
    assert.equal(marks[0].edge, 'start'); assert.equal(marks.at(-1).edge, 'end');
    assert.ok(marks.length <= 24);
    assertSpace(marks, width);
  }
  const narrow = ticks('2026-01-01T00:00:00Z', '2026-12-31T23:59:59.999Z', 240);
  const wide = ticks('2026-01-01T00:00:00Z', '2026-12-31T23:59:59.999Z', 900);
  assert.ok(narrow.length < wide.length);
  assert.equal(wide.length, 13, 'a full year at ample width has monthly boundaries and both edges');
});

test('clipping a birth year preserves the actual first moment and only visible boundaries', () => {
  const from = '1998-08-18T14:00:00Z', to = '1998-12-31T23:59:59.999Z';
  const marks = ticks(from, to);
  assert.equal(marks[0].utc, utc(from)); assert.equal(marks.at(-1).utc, utc(to));
  assert.deepEqual(marks.slice(1, -1).map(mark => new Date(mark.utc).getUTCMonth()), [8, 9, 10, 11]);
  for (const mark of marks) {
    assert.ok(mark.utc >= utc(from) && mark.utc <= utc(to));
    assert.equal(mark.position, (mark.utc - utc(from)) / (utc(to) - utc(from)));
    assert.equal('label' in mark, false, 'this layer only adds ticks, not new text');
  }
});

test('local day boundaries follow a DST change rather than assuming 24-hour days', () => {
  const marks = ticks('2026-03-07T05:00:00Z', '2026-03-11T03:59:59.999Z', 900, { timeZone: 'America/New_York' });
  const middle = marks.slice(1, -1);
  assert.deepEqual(middle.map(mark => new Date(mark.utc).toISOString()), [
    '2026-03-08T05:00:00.000Z', '2026-03-09T04:00:00.000Z', '2026-03-10T04:00:00.000Z',
  ]);
  assert.equal(middle[1].utc - middle[0].utc, 23 * 3600000);
  assertSpace(marks, 900);
});

test('a clipped range shorter than a day uses hours aligned from local midnight', () => {
  const marks = ticks('2026-10-10T06:20:00Z', '2026-10-10T13:15:00Z', 800, { timeZone: 'Asia/Kolkata' });
  assert.deepEqual(marks.slice(1, -1).map(mark => new Date(mark.utc).toISOString()), [
    '2026-10-10T06:30:00.000Z', '2026-10-10T07:30:00.000Z', '2026-10-10T08:30:00.000Z',
    '2026-10-10T09:30:00.000Z', '2026-10-10T10:30:00.000Z', '2026-10-10T11:30:00.000Z', '2026-10-10T12:30:00.000Z',
  ]);
  assertSpace(marks, 800);
});

test('two selected calendar days use their day boundary rather than hourly subdivisions', () => {
  const marks = ticks('2026-10-10T00:00:00Z', '2026-10-11T23:59:59.999Z', 1000);
  assert.deepEqual(marks.map(mark => mark.utc), [utc('2026-10-10T00:00:00Z'), utc('2026-10-11T00:00:00Z'), utc('2026-10-11T23:59:59.999Z')]);
});

test('invalid ranges and unavailable widths do not generate meaningless ticks', () => {
  for (const args of [
    { fromUtc: NaN, toUtc: 1, width: 100 }, { fromUtc: 0, toUtc: Infinity, width: 100 },
    { fromUtc: 2, toUtc: 1, width: 100 }, { fromUtc: 0, toUtc: 1, width: 0 },
    { fromUtc: 0, toUtc: 1, width: -1 }, { fromUtc: 0, toUtc: 1, width: NaN },
    { fromUtc: 0, toUtc: 1, width: Infinity }, { fromUtc: 0, toUtc: 9e15, width: 100 },
  ]) assert.deepEqual(calendarTimelineTicks(args), []);
});

test('a point range uses one exact tick', () => {
  const instant = '2026-10-10T12:30:00Z';
  assert.deepEqual(ticks(instant, instant), [{ utc: utc(instant), position: 0, edge: 'start', unit: 'hour', step: 1, gridIndex: null }]);
  assert.equal(ticks('2026-10-10T12:00:00Z', '2026-10-10T12:00:00Z')[0].gridIndex, 12);
});

test('exceptionally narrow rails preserve both edges and omit colliding internal ticks', () => {
  const marks = ticks('2026-01-01T00:00:00Z', '2026-12-31T23:59:59.999Z', 20);
  assert.equal(marks.length, 2); assert.equal(marks[0].position, 0); assert.equal(marks[1].position, 1);
});


test('tick metadata exposes the chosen calendar step without changing its endpoint or boundary positions', () => {
  const marks = ticks('1998-01-01T00:00:00Z', '2028-01-01T23:59:59.999Z', 342);
  assert.ok(marks.every(mark => mark.unit === 'year' && mark.step === 5));
  assert.deepEqual(marks.map(mark => new Date(mark.utc).toISOString().slice(0, 10)),
    ['1998-01-01', '2000-01-01', '2005-01-01', '2010-01-01', '2015-01-01', '2020-01-01', '2025-01-01', '2028-01-01']);
  assert.deepEqual(marks.map(mark => mark.gridIndex), [null, 400, 401, 402, 403, 404, 405, null]);
  const months = ticks('2026-01-01T00:00:00Z', '2026-12-31T23:59:59.999Z', 320);
  assert.ok(months.every(mark => mark.unit === 'month' && mark.step === 2));
});

test('both exact endpoints join the regular grid without duplicating their ticks', () => {
  const marks = ticks('2026-01-01T00:00:00Z', '2028-01-01T00:00:00Z', 342);
  assert.deepEqual(marks.map(mark => mark.gridIndex), [2026, 2027, 2028]);
  assert.deepEqual(marks.map(mark => mark.edge ?? null), ['start', null, 'end']);
});

test('a skipped local date preserves its tick without inventing a regularly spaced calendar label', () => {
  const marks = ticks('2011-12-29T10:00:00Z', '2012-01-04T09:59:59.999Z', 342, { timeZone: 'Pacific/Apia' });
  assert.equal(marks[1].utc, utc('2011-12-30T10:00:00Z'), 'the boundary lands on 31 December after the skipped date');
  assert.equal(marks[1].gridIndex, null, '31 December is outside the selected two-day calendar phase');
  assert.ok(Number.isInteger(marks[2].gridIndex));
  assert.equal(marks[3].gridIndex, marks[2].gridIndex + 1);
});
