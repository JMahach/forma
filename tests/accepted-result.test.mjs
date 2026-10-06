import test from 'node:test';
import assert from 'node:assert/strict';
import { createChartSession } from '../src/state/chart-session.js';

function harness() {
  const natal = { id: 'natal', name: 'Марат', source: 'calculated', utc: '1998-08-18T15:00:00Z', personality: [63], design: [41] };
  let archive = null;
  const session = createChartSession({ store: { get: id => id === natal.id ? natal : null, has: id => id === natal.id },
    getLifetime: () => ({ get current() { return archive; }, close() {} }) });
  session.select(natal.id);
  return { session, natal, set archive(value) { archive = value; } };
}
const moment = utc => ({ id: `moment:${utc}`, source: 'transit', utc, personality: [4], design: [] });

test('controller data and repaint notifications cannot replace the accepted result without publication', () => {
  const h = harness(), accepted = h.session.current;
  h.archive = moment('2050-01-01T12:10:00Z');
  h.session.refresh();
  assert.equal(h.session.current, accepted);
  assert.equal(h.session.current.primary, h.natal);
});

test('pending exact return retains the accepted subject and UTC until its verified event arrives atomically', () => {
  const { session, natal } = harness();
  const archive = session.expect('archive');
  const first = moment('2050-01-01T12:10:00Z');
  session.publish(archive, first);
  const accepted = session.current, request = session.expect('return');
  assert.equal(session.shownSource, 'archive');
  assert.equal(session.current, accepted);
  assert.equal(accepted.primary, natal);
  assert.equal(accepted.utc, first.utc);
  const exact = moment('2050-01-01T12:14:59.123456Z');
  const verified = { id: 'saturn:2050-01-01T12:14:59.123456Z', body: 'saturn', utc: exact.utc };
  session.publish(request, exact, verified);
  assert.equal(session.shownSource, 'return');
  assert.equal(session.current.event, verified);
  assert.equal(session.current.secondary, exact);
  assert.equal(session.current.utc, verified.utc);
});

test('a canceled owner cannot publish after another mode or another selection has claimed the view', () => {
  const { session, natal } = harness();
  const old = session.expect('archive');
  session.expect('natal-day');
  assert.equal(session.publish(old, moment('2050-01-01T12:10:00Z')), false);
  assert.equal(session.current.primary, natal);
  const oldDay = session.expect('natal-day');
  session.select('current-transit');
  const selected = session.current;
  assert.equal(session.publish(oldDay, { ...natal, utc: '1998-08-18T16:00:00Z' }), false);
  assert.equal(session.current, selected);
});

test('one archive owner accepts intermediate ready progress and keeps references on repeated publications', () => {
  const { session, natal } = harness(), owner = session.expect('archive');
  const first = moment('2050-01-01T12:10:00Z'), next = moment('2050-01-01T12:20:00Z');
  assert.equal(session.publish(owner, first), true);
  const accepted = session.current;
  session.publish(owner, first);
  assert.equal(session.current, accepted);
  assert.equal(session.publish(owner, next), true);
  assert.equal(session.current.primary, natal);
  assert.equal(session.current.secondary, next);
});
