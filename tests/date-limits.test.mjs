import test from 'node:test';
import assert from 'node:assert/strict';
import { calendarAnniversaryUtc, natalDateAllowed } from '../shared/date-limits.js';
import { lifeTimelineForChart, cycleEventWithinRange } from '../src/domain/cycles.js';
import { completedAge, lifeDecadeMarks, ageText } from '../src/domain/personal-age.js';

for (const [birth, years, expected] of [
  ['2000-02-29T12:34:56.789Z', 100, '2100-03-01T12:34:56.789Z'],
  ['2000-02-29T12:34:56.789Z', 1, '2001-03-01T12:34:56.789Z'],
  ['1980-02-29T12:34:56.789Z', 100, '2080-02-29T12:34:56.789Z'],
  ['2000-02-29T12:34:56.789Z', 400, '2400-02-29T12:34:56.789Z'],
  ['2000-01-31T12:34:56.789Z', 100, '2100-01-31T12:34:56.789Z'],
]) test(`UTC anniversary keeps the birth clock: ${birth} plus ${years} years`, () => {
  assert.equal(new Date(calendarAnniversaryUtc(Date.parse(birth), years)).toISOString(), expected);
});

test('the leap-day centenary includes completed age and the hundred-year mark', () => {
  const natal = { utc: '2000-02-29T12:00:00Z', timezone: 'UTC' };
  const span = lifeTimelineForChart(natal);
  assert.deepEqual(span, { fromDate: '2000-02-29', toDate: '2100-03-01', maximumUtc: '2100-03-01T12:00:00.000Z' });
  assert.equal(cycleEventWithinRange(natal, '2100-03-01T12:00:00Z'), true);
  assert.equal(cycleEventWithinRange(natal, '2100-03-01T12:00:00.001Z'), false);
  assert.equal(completedAge('2100-02-28T23:59:59.999Z', natal), 99);
  assert.equal(completedAge(span.maximumUtc, natal), 100);
  assert.equal(ageText(completedAge(span.maximumUtc, natal)), '100 лет');
  assert.deepEqual(lifeDecadeMarks(natal, Date.parse(natal.utc), Date.parse(span.maximumUtc)).at(-1),
    { age: 100, utc: Date.parse('2100-03-01T00:00:00Z') });
});

test('UTC span and local age retain their separate calendar semantics', () => {
  const natal = { utc: '2000-02-29T12:00:00Z', timezone: 'America/New_York' };
  assert.equal(lifeTimelineForChart(natal).maximumUtc, '2100-03-01T12:00:00.000Z');
  assert.equal(completedAge('2100-03-01T04:59:59Z', natal), 99);
  assert.equal(completedAge('2100-03-01T05:00:00Z', natal), 100);
  assert.deepEqual(lifeDecadeMarks(natal, Date.parse(natal.utc), Date.parse('2100-03-01T12:00:00Z')).at(-1),
    { age: 100, utc: Date.parse('2100-03-01T05:00:00Z') });
});

test('the anniversary policy does not extend natal admission or ephemeris coverage', () => {
  assert.equal(natalDateAllowed('1801-01-01'), true);
  assert.equal(natalDateAllowed('2299-12-31'), true);
  assert.equal(natalDateAllowed('1800-12-31'), false);
  assert.equal(natalDateAllowed('2300-01-01'), false);
  assert.equal(lifeTimelineForChart({ utc: '2340-02-29T12:00:00Z' }).maximumUtc, '2399-12-31T23:59:59.999Z');
  assert.equal(lifeTimelineForChart({ utc: '2400-01-01T00:00:00Z' }), null);
});
