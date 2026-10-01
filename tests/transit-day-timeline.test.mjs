import test from 'node:test';
import assert from 'node:assert/strict';
import { createLocalDayTimeline, localDateAt, timelineIndexAt, timelineMinute, formatTimelineMinute } from '../src/domain/day-timeline.js';

test('a Nepal local day starts at the previous UTC day, including its 45-minute offset', () => {
  const day = createLocalDayTimeline(Date.parse('2026-09-24T12:00:00Z'), 'Asia/Kathmandu');
  assert.equal(day.date, '2026-09-24');
  assert.equal(day.minutes, 1440);
  assert.equal(new Date(day.startUtc).toISOString(), '2026-09-23T18:15:00.000Z');
  assert.equal(new Date(day.endUtc).toISOString(), '2026-09-24T18:15:00.000Z');
  assert.deepEqual(day.packetDates, ['2026-09-23', '2026-09-24']);
  assert.deepEqual(timelineMinute(day, 0), { date: '2026-09-23', packetIndex: 1095, index: 0, utc: day.startUtc });
  assert.equal(formatTimelineMinute(day, 0).time, '00:00');
  assert.equal(formatTimelineMinute(day, 0).offset, 'UTC+5:45');
  assert.equal(formatTimelineMinute(day, 1439).time, '23:59');
});

test('spring and autumn days contain every actual minute, and repeated wall times carry distinct offsets', () => {
  const spring = createLocalDayTimeline(Date.parse('2026-03-08T12:00:00Z'), 'America/New_York');
  const autumn = createLocalDayTimeline(Date.parse('2026-11-01T12:00:00Z'), 'America/New_York');
  assert.equal(spring.minutes, 1380);
  assert.equal(autumn.minutes, 1500);
  assert.equal(formatTimelineMinute(spring, 119).time, '01:59');
  assert.equal(formatTimelineMinute(spring, 120).time, '03:00');
  const first = formatTimelineMinute(autumn, 90), second = formatTimelineMinute(autumn, 150);
  assert.equal(first.time, '01:30');
  assert.equal(second.time, '01:30');
  assert.equal(first.offset, 'UTC-4');
  assert.equal(second.offset, 'UTC-5');
  assert.equal(Date.parse(second.utc) - Date.parse(first.utc), 60 * 60_000);
});

test('half-hour and midnight DST transitions use the real local calendar boundaries', () => {
  for (const [date, zone, minutes, firstTime] of [
    ['2026-04-05', 'Australia/Lord_Howe', 1470, '00:00'],
    ['2026-10-04', 'Australia/Lord_Howe', 1410, '00:00'],
    ['2026-03-08', 'America/Havana', 1380, '01:00'],
    ['2026-11-01', 'America/Havana', 1500, '00:00'],
  ]) {
    const day = createLocalDayTimeline(Date.parse(`${date}T12:00:00Z`), zone);
    assert.equal(day.minutes, minutes, `${zone} ${date}`);
    assert.equal(formatTimelineMinute(day, 0).time, firstTime);
    assert.equal(localDateAt(day.startUtc, zone), date);
    assert.equal(localDateAt(day.endUtc - 60_000, zone), date);
    assert.notEqual(localDateAt(day.startUtc - 60_000, zone), date);
    assert.notEqual(localDateAt(day.endUtc, zone), date);
  }
});

test('every local minute maps to a listed UTC packet and a valid 0–1439 minute, including clamped bounds', () => {
  for (const zone of ['UTC', 'Pacific/Kiritimati', 'Pacific/Pago_Pago', 'Asia/Kathmandu', 'America/New_York']) {
    const day = createLocalDayTimeline(Date.parse('2026-11-01T12:00:00Z'), zone);
    for (let index = 0; index < day.minutes; index++) {
      const minute = timelineMinute(day, index);
      assert.ok(day.packetDates.includes(minute.date));
      assert.ok(Number.isInteger(minute.packetIndex) && minute.packetIndex >= 0 && minute.packetIndex < 1440);
      assert.equal(timelineIndexAt(day, minute.utc), index);
    }
    assert.equal(timelineIndexAt(day, day.startUtc - 999_999), 0);
    assert.equal(timelineIndexAt(day, day.endUtc + 999_999), day.minutes - 1);
    assert.equal(timelineMinute(day, -5).index, 0);
    assert.equal(timelineMinute(day, 1e6).index, day.minutes - 1);
  }
});

test('views reuse one exact UTC/zone label across timeline origins without sharing mutable results', t => {
  const formatToParts = Intl.DateTimeFormat.prototype.formatToParts;
  const formatting = t.mock.method(Intl.DateTimeFormat.prototype, 'formatToParts', function (...args) {
    return formatToParts.apply(this, args);
  });
  const timeline = { startUtc: Date.parse('2026-11-01T04:00:00Z'), minutes: 1500, timeZone: 'America/New_York' };
  const exact = { ...timeline, startUtc: Date.parse('2026-11-01T05:30:00Z'), minutes: 1 };
  const first = formatTimelineMinute(timeline, 90), shown = formatTimelineMinute(exact, 0);
  assert.deepEqual(first, shown);
  assert.notEqual(first, shown);
  assert.equal(formatting.mock.callCount(), 1, 'two views format one instant only once');
  first.time = 'changed by caller'; shown.offset = 'changed by another caller';
  assert.equal(formatTimelineMinute(exact, 0).time, '01:30');
  assert.equal(formatTimelineMinute(exact, 0).offset, 'UTC-4');
  assert.equal(formatting.mock.callCount(), 1);

  const secondFold = formatTimelineMinute(timeline, 150);
  assert.equal(secondFold.time, '01:30'); assert.equal(secondFold.offset, 'UTC-5');
  assert.equal(secondFold.utc, '2026-11-01T06:30:00.000Z');
  assert.equal(formatting.mock.callCount(), 2, 'the same wall clock at another UTC is a distinct label');
  const otherZone = formatTimelineMinute({ ...timeline, timeZone: 'Asia/Kathmandu' }, 150);
  assert.equal(otherZone.time, '12:15'); assert.equal(otherZone.offset, 'UTC+5:45');
  assert.equal(formatting.mock.callCount(), 3, 'an explicit zone change invalidates the reused label');
  formatTimelineMinute(timeline, 150);
  assert.equal(formatting.mock.callCount(), 4, 'only the latest label is retained');
  const subminute = formatTimelineMinute({ ...exact, startUtc: exact.startUtc + 1 }, 0);
  assert.equal(subminute.utc, '2026-11-01T05:30:00.001Z', 'exact UTC is never rounded to the visible minute');
  assert.equal(formatting.mock.callCount(), 5);
});
