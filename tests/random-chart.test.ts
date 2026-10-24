import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBirthMoment, moscowBirthAt } from '../src/views/random-chart.ts';

test('random examples stay inside a supported past range and produce real calendar minutes', () => {
  assert.deepEqual(randomBirthMoment(() => 0), { date: '1950-01-01', time: '03:00', name: 'Пример 01.01.1950', utc: '1950-01-01T00:00:00.000Z', fold: 0 });
  const last = randomBirthMoment(() => 1 - Number.EPSILON);
  assert.equal(last.utc, '2005-12-31T20:59:00.000Z');
  assert.equal(last.date, '2005-12-31'); assert.equal(last.time, '23:59');
  const start = Date.UTC(1950, 0, 1), end = Date.UTC(2005, 11, 31, 21);
  const leap = randomBirthMoment(() => (Date.UTC(2000, 1, 29, 12, 34) - start + 1000) / (end - start));
  assert.equal(leap.date, '2000-02-29'); assert.equal(leap.time, '15:34');
  for (let i = 0; i < 1000; i++) {
    const birth = randomBirthMoment(() => i / 1000);
    assert.equal(new Date(`${birth.date}T${birth.time}:00Z`).toISOString().slice(0, 16), `${birth.date}T${birth.time}`);
    assert.match(birth.name, /^Пример /);
    assert.ok(birth.name.length <= 30);
  }
});

test('Moscow conversion preserves both real UTC occurrences of an ambiguous civil minute', () => {
  const early = moscowBirthAt(new Date('2004-10-30T22:30:00Z'));
  const late = moscowBirthAt(new Date('2004-10-30T23:30:00Z'));
  assert.equal(early.date, '2004-10-31'); assert.equal(early.time, '02:30');
  assert.equal(late.date, early.date); assert.equal(late.time, early.time);
  assert.equal(early.fold, 0); assert.equal(late.fold, 1);
  const beforeGap = moscowBirthAt(new Date('2004-03-27T22:30:00Z'));
  const afterGap = moscowBirthAt(new Date('2004-03-27T23:30:00Z'));
  assert.equal(beforeGap.time, '01:30'); assert.equal(afterGap.time, '03:30');
});
