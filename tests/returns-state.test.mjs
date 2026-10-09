import test from 'node:test';
import assert from 'node:assert/strict';
import * as cycles from '../src/domain/cycles.js';
import { createReturnsController } from '../src/state/returns.js';
import { createChartComposition } from '../src/domain/chart-composition.js';
import { chartCaption } from '../src/views/chart-display.js';
const shown = control => createChartComposition(control.state.natal, { secondary: control.current, kind: 'return', event: control.state.selectedEvent });
const caption = control => chartCaption(shown(control), control.state.natal).title;
import { chartAtMinute } from '../src/domain/natal-day.js';
import { natalDayFixture, personalChartFixture } from './fixtures/natal-day.mjs';
const majorBodies = cycles.DEFAULT_CYCLE_BODIES;
const centuryAge = (Date.parse('2100-01-01T00:00:00Z') - Date.parse('2000-01-01T00:00:00Z')) / (365.2425 * 86400000);
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
function natal(overrides = {}) { return { ...chartAtMinute(natalDayFixture({ date: '2000-01-01' }), 0, personalChartFixture({ id: 'saved-natal', name: 'Анна' })), ...overrides }; }
function event(body = 'saturn', utc = '2028-07-21T12:36:05.920740Z') { return { id: `${body}:${utc}`, body, utc, age: (Date.parse(utc) - Date.parse('2000-01-01T00:00:00Z')) / (365.2425 * 86400000), cycle: 1, pass: 1, cycleId: `${body}:1`, direction: 'direct' }; }
const packet = (input, events = [event(input.body)]) => ({ events, range: { fromAge: input.fromAge, toAge: input.toAge } });
const chartPacket = selected => ({ chart: { ...natal(), utc: selected.utc, timezone: 'UTC', engine: 'Exact worker', designArcResidualDegrees: 1e-12 } });
function freeze(value) { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }
function fast(options = {}) { const calls = []; const control = createReturnsController({ ...options, client: { events: async input => { calls.push(input); return packet(input); }, chart: async input => chartPacket(event(input.body, input.eventUtc)), ...options.client } }); return { control, calls }; }

test('unchanged returns reads reuse prepared events and exported arrays cannot corrupt that preparation', async t => {
  const events = Array.from({ length: 1336 }, (_, i) => event('moon', new Date(Date.UTC(2000, 0, 2) + i * 27 * 86400000).toISOString()));
  const { control } = fast({ client: { events: async input => packet(input, events) } });
  control.select(natal()); await control.setBodies(['moon']); await control.open();
  const dates = new Set(events.map(value => value.utc)), parse = Date.parse; let reads = 0;
  t.mock.method(Date, 'parse', value => { if (dates.has(value)) reads++; return parse(value); });
  for (const year of [null, 2026]) {
    await control.setYear(year); const expected = control.state.events.map(value => value.id); reads = 0;
    const exported = control.state.events; exported.splice(0, exported.length);
    for (let i = 0; i < 200; i++) assert.equal(control.state.available, true);
    assert.deepEqual(control.state.events.map(value => value.id), expected);
    assert.equal(reads, 0, 'unchanged reads must not parse event dates again');
  }
  await control.setBodies([]); assert.deepEqual(control.state.events, []);
  await control.setBodies(['moon']); assert.ok(control.state.events.length > 0);
  const prepared = control.state.events; control.exit(); assert.equal(control.state.opened, false); assert.deepEqual(control.state.events, prepared);
});

test('combined filters reuse full-life results and retain an explicitly empty choice', async () => {
  const before = event('sun', '2025-12-31T23:30:00Z'), after = event('sun', '2026-12-31T23:30:00Z');
  const calls = [], { control } = fast({ client: { events: async input => {
    calls.push(input); return packet(input, input.body === 'sun' ? [before, after] : []);
  } } });
  control.select(natal({ timezone: 'Europe/Moscow' }));
  assert.equal(control.state.year, null);
  await control.setBodies(['sun', 'moon', 'sun']); await control.setYear(2026); await control.open();
  assert.deepEqual(control.state.bodies, ['sun', 'moon']);
  assert.deepEqual(control.state.events.map(item => item.id), [before.id]);
  assert.ok(calls.every(input => input.fromAge === 0 && input.toAge === centuryAge));
  await control.setYear(2027); assert.deepEqual(control.state.events.map(item => item.id), [after.id]);
  await control.setYear(null); assert.equal(control.state.events.length, 2);
  await control.setBodies([]); assert.deepEqual(control.state.events, []); assert.deepEqual(control.state.bodies, []);
  await control.setBodies(['moon', 'sun']); assert.equal(calls.length, majorBodies.length + 2, 'empty Moon results are loaded results too');
  assert.equal(control.state.events.length, 2);
  assert.equal(control.setBodies(['earth']), false); assert.equal(control.setBodies('sun'), false);
  assert.equal(control.setYear(undefined), false);
});

test('filter changes preserve an exact request even when its event is no longer visible', async () => {
  const hold = deferred(); let signal;
  const { control } = fast({ client: { chart: (input, value) => { signal = value; return hold.promise; } } });
  control.select(natal()); await control.open();
  const selecting = control.selectEvent(event()); await tick();
  await control.setBodies([]); await control.setYear(2040);
  assert.equal(signal.aborted, false); assert.equal(control.state.loadingChart, true);
  hold.resolve(chartPacket(event())); assert.equal(await selecting, true);
  assert.deepEqual(control.state.events, []); assert.equal(control.current.utc, event().utc);
  await control.setYear(null); assert.equal(control.state.selectedEvent.id, event().id);
});

test('turning a body off and on shares its ongoing preparation without restarting it', async () => {
  const jobs = [], { control } = fast({ client: { events: (input, signal) => {
    const job = { input, signal, ...deferred() }; jobs.push(job); return job.promise;
  } } });
  control.select(natal()); const first = control.setBodies(['sun']); await tick();
  await control.setBodies([]); const second = control.setBodies(['sun']); await tick();
  assert.equal(jobs.length, majorBodies.length + 1); assert.ok(jobs.every(job => !job.signal.aborted));
  jobs.forEach(job => job.resolve(packet(job.input))); await Promise.all([first, second]);
  assert.deepEqual(control.state.pendingBodies, []); assert.equal(control.state.events[0].body, 'sun');
});

test('an exact request starts immediately after its own list without waiting for other bodies', async () => {
  const h = deferredRestore(); const opening = h.control.open(); await tick();
  h.jobs.find(job => job.input.body === 'saturn').resolve(packet({ body: 'saturn' })); await tick();
  const selecting = h.control.selectEvent(event().id); await tick();
  assert.equal(h.charts.length, 1); assert.equal(h.jobs.length, majorBodies.length);
  h.charts[0].resolve(chartPacket(event())); assert.equal(await selecting, true);
  await h.finishLists(); await opening;
});

test('closed filters restore empty choices while preparation stays independent', async () => {
  const { control, calls } = fast(); control.select(natal());
  assert.equal(await control.restore({ opened: false, bodies: [], year: 2040, eventId: null }), true);
  await control.enableMarkers(true);
  assert.deepEqual(control.state.bodies, []); assert.deepEqual(control.state.events, []);
  assert.equal(control.state.year, 2040); assert.equal(calls.length, majorBodies.length);
});

test('an obsolete timezone does not prevent opening a saved chart or filtering its returns', async () => {
  const { control } = fast();
  assert.doesNotThrow(() => control.select(natal({ timezone: 'Obsolete/Zone' })));
  await control.setBodies(['saturn']); await control.setYear(2028); await control.open();
  assert.equal(control.state.events[0].id, event().id);
  assert.equal(control.state.minYear, 2000);
});

test('only saved calculated natal charts enable returns; major defaults exclude fast bodies', async () => {
  const { control, calls } = fast();
  for (const chart of [null, { ...natal(), source: 'manual' }, { ...natal(), source: 'transit' }, { ...natal(), activations: { personality: [], design: [] } }]) { control.select(chart); await control.open(); assert.equal(control.state.available, false); }
  assert.equal(calls.length, 0); const source = freeze(natal()); control.select(source); await control.open();
  assert.equal(control.state.natal, source); assert.equal(control.current, null); assert.equal(control.state.opened, true);
  assert.equal(control.state.year, null); assert.deepEqual(control.state.bodies, ['north_node', 'saturn', 'uranus_opposition', 'chiron', 'uranus']);
  assert.deepEqual(calls.map(input => input.body), majorBodies);
  assert.ok(calls.every(input => input.birthUtc === source.utc && input.fromAge === 0 && input.toAge === centuryAge));
});
test('prepared bodies publish incrementally and filters never restart or abort their requests', async () => {
  const jobs = [];
  const control = createReturnsController({ client: { events(input, signal) { const job = { input, signal, ...deferred() }; jobs.push(job); return job.promise; } } });
  control.select(natal()); const opening = control.open(); await tick(); assert.equal(jobs.length, majorBodies.length);
  const node = jobs.find(job => job.input.body === 'north_node'); node.resolve(packet(node.input)); await tick();
  assert.equal(control.state.events.length, 1);
  const switched = control.setBodies(['sun', 'mercury', 'venus', 'mars']); await tick();
  assert.ok(jobs.every(job => !job.signal.aborted)); assert.equal(jobs.length, majorBodies.length + 4);
  jobs.forEach(job => job.resolve(packet(job.input))); await Promise.all([opening, switched]);
  assert.deepEqual(control.state.events.map(item => item.body).sort(), ['mars', 'mercury', 'sun', 'venus']);
});
test('close retains preparation but selecting another natal rejects its late responses', async () => {
  const jobs = []; const control = createReturnsController({ client: { events(input, signal) { const job = { input, signal, ...deferred() }; jobs.push(job); return job.promise; } } });
  control.select(natal()); const opening = control.open(); await tick(); control.close();
  assert.ok(jobs.every(job => !job.signal.aborted)); jobs.forEach(job => job.resolve(packet(job.input))); await opening;
  assert.equal(control.state.opened, false); assert.equal(control.state.events.length, 5);
  control.select(natal({ id: 'second' })); const next = control.open(); await tick(); const previous = [...jobs];
  control.select(natal({ id: 'third' })); previous.forEach(job => job.resolve(packet(job.input))); await next;
  assert.equal(control.state.natal.id, 'third'); assert.deepEqual(control.state.events, []);
  assert.ok(previous.slice(majorBodies.length).every(job => job.signal.aborted));
  await tick(); jobs.forEach(job => job.resolve(packet(job.input))); await tick();
});
test('selected bodies filter locally by natal year while searches retain the full life', async () => {
  const outside = event('sun', '2026-12-31T23:30:00Z'), inside = event('sun', '2025-12-31T23:30:00Z');
  const { control, calls } = fast({ client: { events: async input => { calls.push(input); return packet(input, input.body === 'sun' ? [inside, outside] : []); } } });
  control.select(natal({ timezone: 'Europe/Moscow' })); await control.setBodies(['sun', 'moon']); await control.setYear(2026); await control.open();
  assert.deepEqual(calls.map(input => input.body), [...majorBodies, 'sun', 'moon']);
  assert.ok(calls.every(input => input.fromAge === 0 && input.toAge === centuryAge));
  assert.deepEqual(control.state.events.map(item => item.id), [inside.id]);
  await control.setYear(2027); assert.deepEqual(control.state.events.map(item => item.id), [outside.id]);
  assert.equal(calls.length, majorBodies.length + 2);
});

test('selected years clamp to birth and the supported date range; major range cannot exceed available ephemerides', async () => {
  const { control, calls } = fast(); control.select(natal({ utc: '2380-06-01T12:00:00Z' })); await control.open();
  assert.equal(control.state.year, null); assert.ok(calls.every(input => input.toAge < 20 && input.toAge > 19));
  await control.setYear(1801); assert.equal(control.state.year, 2380); await control.setYear(9999); assert.equal(control.state.year, 2399);
  await control.setBodies(['sun']);
  const solar = calls.find(input => input.body === 'sun'); assert.equal(solar.fromAge, 0); assert.ok(solar.toAge < 20 && solar.toAge > 19);
});

test('planet exploration keeps Sun, Moon and node returns across the whole hundred-year life', async () => {
  for (const body of ['sun', 'moon', 'north_node']) {
    const life = ['2001-01-01T00:00:00Z', '2026-10-01T12:00:00Z', '2099-06-01T00:00:00Z'].map(utc => event(body, utc));
    const calls = [];
    const { control } = fast({ client: { events: async input => {
      calls.push(input);
      return packet(input, life.filter(item => item.body === input.body && item.age >= input.fromAge && item.age <= input.toAge));
    } } });
    control.select(natal({ timezone: 'Europe/Moscow' })); await control.setBodies([body]); await control.open();
    assert.deepEqual(control.state.events.map(item => item.id), life.map(item => item.id));
    assert.ok(calls.every(input => input.fromAge === 0 && input.toAge === centuryAge));
    await control.setYear(2040);
    assert.deepEqual(control.state.events, []);
    await control.setYear(null); assert.deepEqual(control.state.events.map(item => item.id), life.map(item => item.id));
    assert.equal(calls.length, new Set([...majorBodies, body]).size);
  }
});

test('year browsing clamps a late year to the same hundred-year life range', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2117-04-01T12:00:00Z') });
  const { control, calls } = fast(); control.select(natal());
  await control.setYear(2117); await control.open();
  assert.equal(control.state.maxYear, 2100); assert.equal(control.state.year, 2100);
  assert.ok(calls.every(input => input.fromAge === 0 && input.toAge === centuryAge));
});
test('exact result is temporary and metadata-rich; selecting an event keeps the desktop list open and natal unchanged', async () => {
  const source = freeze(natal()), before = JSON.stringify(source), selected = event(); const requests = [];
  const { control } = fast({ client: { chart: async input => { requests.push(input); return chartPacket(selected); } } });
  control.select(source); await control.open(); await control.selectEvent({ ...selected, body: 'moon', utc: '2030-01-01T00:00:00Z' });
  assert.equal(requests[0].body, 'saturn'); assert.equal(requests[0].eventUtc, selected.utc); assert.equal(requests[0].timezone, 'UTC');
  assert.equal(shown(control).id, `${source.id}:cycle:${selected.id}`); assert.equal(caption(control), 'Анна · Возврат Сатурна 1');
  assert.equal(control.current.engine, 'Exact worker'); assert.equal(control.current.designArcResidualDegrees, 1e-12); assert.equal(control.current.utc, selected.utc);
  assert.equal(control.state.opened, true); assert.equal(JSON.stringify(source), before);
  const preview = control.current; control.close(); assert.equal(control.current, preview); assert.equal(control.state.opened, false);
  await control.open(); control.reset(); assert.equal(control.current, null); assert.equal(control.state.opened, true); control.exit(); assert.equal(control.state.opened, false);
});
test('later selection wins, and close and reset cannot resurrect a pending chart', async () => {
  const first = event(), second = event('saturn', '2029-04-01T23:24:11.690590Z'), jobs = [];
  const { control } = fast({ client: { events: async input => packet(input, input.body === 'saturn' ? [first, second] : []), chart(input, signal) { const job = { input, signal, ...deferred() }; jobs.push(job); return job.promise; } } });
  control.select(natal()); await control.open(); const older = control.selectEvent(first); await tick(); const newer = control.selectEvent(second); await tick();
  assert.equal(jobs[0].signal.aborted, true); jobs[1].resolve(chartPacket(second)); await newer; jobs[0].resolve(chartPacket(first)); await older;
  assert.equal(control.state.selectedEvent.id, second.id);
  for (const stop of [() => control.close(), () => control.reset()]) {
    await control.open(); const pending = control.selectEvent(first); await tick(); const job = jobs.at(-1); stop(); job.resolve(chartPacket(first)); await pending;
    assert.notEqual(control.current?.utc, first.utc);
  }
});
test('event errors retry failed bodies only; chart retry does not discard the existing preview', async () => {
  const attempts = new Map(); let chartCalls = 0; const selected = event();
  const { control } = fast({ client: { events: async input => { attempts.set(input.body, (attempts.get(input.body) || 0) + 1); if (input.body === 'saturn' && attempts.get(input.body) === 1) throw Object.assign(new Error('Busy'), { code: 'cycles_busy' }); return packet(input); }, chart: async () => { if (++chartCalls === 1) throw new Error('Try chart'); return chartPacket(selected); } } });
  control.select(natal()); await control.open(); assert.equal(control.state.errors[0].code, 'cycles_busy'); await control.retry();
  assert.equal(attempts.get('saturn'), 2); assert.equal(attempts.get('north_node'), 1); await control.selectEvent(selected); assert.equal(control.state.chartError, 'Try chart');
  await control.retry(); assert.equal(control.state.chartError, ''); assert.equal(control.current.utc, selected.utc);
});
test('renaming a natal preserves existing exact preview ownership without writes or fetching again', async () => {
  const { control, calls } = fast(); const source = natal(); control.select(source); await control.open(); await control.selectEvent(event());
  const count = calls.length, renamed = freeze({ ...source, name: 'Новое имя', activations: structuredClone(source.activations) });
  control.select(renamed);
  assert.equal(caption(control), 'Новое имя · Возврат Сатурна 1'); assert.equal(control.state.opened, true); assert.equal(calls.length, count);
  assert.notEqual(control.current.activations, renamed.activations, 'renaming natal does not replace the verified moment activations');
  assert.equal(control.state.natal, renamed);
});

test('background markers load exact majors without opening the panel or changing the displayed chart', async () => {
  const { control, calls } = fast(); control.select(freeze(natal()));
  assert.equal(control.state.markersEnabled, false); await control.enableMarkers(true);
  assert.equal(control.state.opened, false); assert.equal(control.current, null);
  assert.equal(control.state.events.length, 5); assert.deepEqual(calls.map(input => input.body), majorBodies);
  const requests = calls.length; await control.open(); assert.equal(calls.length, requests, 'opening the major list reuses marker results');
  await control.setYear(2040); assert.equal(control.state.events.length, 0);
  await control.setYear(null); assert.equal(control.state.events.length, 5); assert.equal(calls.length, requests);
});
test('a stored marker selects its exact chart while the popup stays closed; unknown IDs do nothing', async () => {
  const calls = [], { control } = fast({ client: { chart: async input => { calls.push(input); return chartPacket(event(input.body, input.eventUtc)); } } });
  control.select(natal()); await control.enableMarkers(true);
  assert.equal(await control.selectEvent('not-loaded'), false); assert.equal(calls.length, 0);
  const selected = control.state.events.find(item => item.body === 'saturn');
  await control.selectEvent({ ...selected, body: 'moon', utc: '2035-01-01T00:00:00Z' });
  assert.equal(calls[0].body, 'saturn'); assert.equal(calls[0].eventUtc, selected.utc);
  assert.equal(control.state.opened, false); assert.equal(control.current.utc, selected.utc);
});
test('close and year filtering reuse ongoing preparation for the selected natal', async () => {
  const jobs = [];
  const control = createReturnsController({ client: { events(input, signal) { const job = { input, signal, ...deferred() }; jobs.push(job); return job.promise; } } });
  control.select(natal()); const markers = control.enableMarkers(true); await tick();
  const opening = control.open(); assert.equal(jobs.length, majorBodies.length);
  const node = jobs.find(job => job.input.body === 'north_node'); node.resolve(packet(node.input)); await tick();
  assert.equal(control.state.events.length, 1);
  const annual = control.setYear(2028); control.close(); assert.ok(jobs.every(job => !job.signal.aborted));
  jobs.forEach(job => job.resolve(packet(job.input))); await Promise.all([markers, opening, annual]);
  assert.equal(control.state.opened, false); assert.equal(control.state.events.length, 5); assert.equal(control.current, null);
});
test('disabling markers retains preparation; switching natal cancels old lists and the old chart', async () => {
  const jobs = [], charts = []; const { control } = fast({ client: { events(input, signal) { const job = { input, signal, ...deferred() }; jobs.push(job); return job.promise; }, chart(input, signal) { const job = { input, signal, ...deferred() }; charts.push(job); return job.promise; } } });
  control.select(natal()); const disabled = control.enableMarkers(true); await tick(); control.enableMarkers(false);
  assert.ok(jobs.every(job => !job.signal.aborted)); jobs.forEach(job => job.resolve(packet(job.input))); await disabled;
  const chart = control.selectEvent(event().id); await tick(); control.select(natal({ id: 'other' }));
  const job = charts.at(-1); assert.equal(job.signal.aborted, true); job.resolve(chartPacket(event())); await chart;
  assert.equal(control.current, null); assert.equal(control.state.selectedEvent, null);
  await tick(); jobs.forEach(job => job.resolve(packet(job.input))); await tick();
});

test('repeated marker enable is idempotent so app state notifications cannot form a render loop', async () => {
  let notices = 0; const { control, calls } = fast({ onStateChange: () => notices++ });
  control.select(natal()); await control.enableMarkers(true); const before = notices, requests = calls.length;
  await control.enableMarkers(true); assert.equal(notices, before); assert.equal(calls.length, requests);
  control.exit(); assert.equal(control.state.markersEnabled, false); assert.equal(control.state.events.length, 5);
});

test('scrubbing with no return selection or open list publishes no redundant state or render', async () => {
  for (const markers of [false, true]) {
    let notices = 0, renders = 0;
    const { control, calls } = fast({ onStateChange: () => notices++, onRender: () => renders++ });
    control.select(natal()); await control.enableMarkers(markers);
    const before = control.state, requests = calls.length;
    notices = renders = 0;
    for (let index = 0; index < 20; index++) { control.reset(); await control.close(); }
    assert.deepEqual(control.state, before);
    assert.equal(notices, 0, 'unchanged return state should not rebuild its views during scrub');
    assert.equal(renders, 0, 'scrub owns the render when there is no return preview to clear');
    assert.equal(calls.length, requests);
  }
});

test('reset publishes the cleared exact preview only once', async () => {
  let notices = 0, renders = 0;
  const { control } = fast({ onStateChange: () => notices++, onRender: () => renders++ });
  control.select(natal()); await control.enableMarkers(true); await control.selectEvent(event());
  assert.ok(control.current);
  notices = renders = 0;
  control.reset();
  assert.equal(control.current, null); assert.equal(control.state.selectedEvent, null);
  assert.equal(notices, 1); assert.equal(renders, 1);
  control.reset();
  assert.equal(notices, 1); assert.equal(renders, 1);
});

test('closing an already hidden restore cancels its ownership while background majors continue quietly', async () => {
  const jobs = []; let notices = 0, renders = 0, chartCalls = 0;
  const { control } = fast({ onStateChange: () => notices++, onRender: () => renders++, client: {
    events(input, signal) { const job = { input, signal, ...deferred() }; jobs.push(job); return job.promise; },
    chart: async input => { chartCalls++; return chartPacket(event(input.body, input.eventUtc)); },
  } });
  control.select(natal());
  const restoring = control.restore({ opened: false, bodies: [...cycles.DEFAULT_CYCLE_BODIES], eventId: event().id });
  await tick(); assert.equal(jobs.length, majorBodies.length); assert.equal(control.state.opened, false);
  notices = renders = 0;
  control.reset(); const closing = control.close();
  assert.equal(notices, 0); assert.equal(renders, 0);
  for (let guard = 0; guard < 10 && control.state.pendingBodies.length; guard++) {
    for (const job of jobs) { assert.equal(job.signal.aborted, false); job.resolve(packet(job.input)); }
    await tick();
  }
  assert.equal(await restoring, false); await closing;
  assert.equal(chartCalls, 0); assert.equal(control.current, null);
  assert.equal(control.state.events.length, 5); assert.equal(jobs.length, majorBodies.length);
});


test('major life search keeps returns before age 100 and excludes later events', async () => {
  const within = event('saturn', '2099-06-01T12:00:00Z'), late = event('saturn', '2110-06-01T12:00:00Z');
  const { control, calls } = fast({ client: { events: async input => { calls.push(input); return packet(input, [within, late].filter(item => item.body === input.body && item.age <= input.toAge)); } } });
  control.select(natal()); await control.open();
  assert.ok(within.age < 100 && late.age > 100); assert.deepEqual(control.state.events.map(item => item.id), [within.id]);
  assert.ok(calls.every(input => input.fromAge === 0 && input.toAge === centuryAge));
});
test('fixed life timeline follows UTC birth date and its calendar 100-year anniversary', () => {
  for (const [utc, fromDate, toDate] of [
    ['1996-10-04T12:00:00Z', '1996-10-04', '2096-10-04'],
    ['1980-02-29T06:00:00Z', '1980-02-29', '2080-02-29'],
    ['2000-02-29T06:00:00Z', '2000-02-29', '2100-02-28'],
    ['1996-10-03T23:30:00Z', '1996-10-03', '2096-10-03'],
    ['2290-12-31T23:59:00Z', '2290-12-31', '2390-12-31'],
    ['2340-12-31T23:59:00Z', '2340-12-31', '2399-12-31'],
    ['2399-12-31T23:59:00Z', '2399-12-31', '2399-12-31'],
  ]) {
    const maximumUtc = Number(utc.slice(0, 4)) + 100 > 2399 ? '2399-12-31T23:59:59.999Z' : `${toDate}${utc.slice(10, -1)}.000Z`;
    assert.deepEqual(cycles.lifeTimelineForChart({ utc, timezone: 'Asia/Tokyo' }), { fromDate, toDate, maximumUtc });
  }
});
test('invalid or unsupported life-timeline birth moments have no invented range', () => {
  for (const chart of [null, {}, { utc: 'bad' }, { utc: '1900-02-29T00:00:00Z' }, { utc: '1800-12-31T23:59:00Z' }, { utc: '2400-01-01T00:00:00Z' }]) {
    assert.equal(cycles.lifeTimelineForChart(chart), null);
  }
});


test('an exact return overlays both original charts without mutating natal ownership', async () => {
  const source = freeze(natal()), selected = event();
  const cycle = { ...natal(), personality: [2, 14], design: [3, 60], utc: selected.utc };
  const { control } = fast({ client: { chart: async () => ({ chart: cycle, event: selected }) } });
  control.select(source); await control.open(); await control.selectEvent(selected.id);
  assert.equal(control.state.natal, source);
  assert.equal(control.current.utc, selected.utc);
  assert.equal(control.current, cycle);
  assert.deepEqual(shown(control).topology.personality, [...new Set([...source.personality, 2, 14])].sort((a,b) => a-b));
  assert.deepEqual(shown(control).topology.design, [...new Set([...source.design, 3, 60])].sort((a,b) => a-b));
  assert.equal(control.current.utc, selected.utc);
  control.select({ ...source, id: 'other' });
  assert.equal(control.current, null); assert.equal(control.state.selectedEvent, null);
});

test('a saved exact return restores selection, list filters and cycle number in the same chart', async () => {
  const selected = { ...event(), cycle: 2, cycleId: 'saturn:2' };
  const { control } = fast({ client: { events: async input => packet(input, input.body === 'saturn' ? [selected] : []), chart: async () => chartPacket(selected) } });
  control.select(natal());
  assert.equal(await control.restore({ opened: true, year: 2030, bodies: ['saturn'], eventId: selected.id }), true);
  assert.equal(control.state.opened, true); assert.deepEqual(control.state.bodies, ['saturn']);
  assert.equal(control.state.year, 2030); assert.equal(control.state.selectedEvent.id, selected.id);
  assert.equal(caption(control), 'Анна · Возврат Сатурна 2');
});


test('a selected return outside the restored list keeps its exact event and hidden list state', async () => {
  const selected = event('sun', '2027-01-01T00:00:00Z');
  const { control } = fast({ client: { events: async input => packet(input, input.body === 'sun' ? [selected] : []) } });
  control.select(natal());
  assert.equal(await control.restore({ opened: false, year: 2027, bodies: [...cycles.DEFAULT_CYCLE_BODIES], eventId: selected.id, event: selected }), true);
  assert.equal(control.state.opened, false); assert.equal(control.state.selectedEvent.id, selected.id);
  assert.equal(caption(control), 'Анна · Соляр 1');
});

function deferredRestore() {
  const jobs = [], charts = [], order = [], renders = [];
  const control = createReturnsController({ onRender: () => renders.push(control.current), client: {
    events(input, signal) { const job = { input, signal, ...deferred() }; jobs.push(job); order.push(`events:${input.body}`); return job.promise; },
    chart(input, signal) { const job = { input, signal, ...deferred() }; charts.push(job); order.push('chart'); return job.promise; },
  } });
  control.select(natal());
  return { control, jobs, charts, order, renders, async finishLists() {
    jobs.forEach(job => job.resolve(packet(job.input))); await tick();
  } };
}

test('a saved exact descriptor waits only for its verified body and never trusts a stored ordinal', async () => {
  for (const filter of [{ opened: true, bodies: ['sun', 'moon'] }, { opened: false, bodies: ['moon'] }, { opened: false, bodies: [] }]) {
    const h = deferredRestore(), selected = event();
    const restoring = h.control.restore({ ...filter, year: 2040, eventId: selected.id, event: { ...selected, cycle: 99 } });
    await tick(); assert.equal(h.charts.length, 0); assert.equal(h.jobs.length, new Set([...majorBodies, ...filter.bodies]).size);
    const body = h.jobs.find(job => job.input.body === 'saturn'); body.resolve(packet(body.input, [selected])); await tick();
    assert.equal(h.charts.length, 1);
    h.charts[0].resolve(chartPacket(selected)); assert.equal(await restoring, true);
    assert.equal(h.control.state.selectedEvent, selected); assert.equal(h.control.state.opened, filter.opened);
    assert.deepEqual(h.control.state.bodies, filter.bodies); assert.equal(h.renders.length, 1);
    await h.finishLists(); assert.equal(h.control.state.events.length, 0);
  }
});

test('a newer selection survives cancellation of a fast exact restore while markers are pending', async () => {
  const h = deferredRestore(), first = event(), next = event('saturn', '2057-07-21T12:36:05Z');
  const restoring = h.control.restore({ opened: false, bodies: [...cycles.DEFAULT_CYCLE_BODIES], eventId: first.id, event: first });
  await tick(); const list = h.jobs.find(job => job.input.body === 'saturn'); list.resolve(packet(list.input, [first, next])); await tick();
  assert.equal(h.charts.length, 1);
  const selecting = h.control.selectEvent(next.id);
  assert.equal(h.charts[0].signal.aborted, true);
  h.charts[0].resolve(chartPacket(first)); await tick();
  assert.equal(await restoring, false); assert.equal(h.charts.length, 2);
  assert.equal(h.charts[1].signal.aborted, false, 'the obsolete restore must not close and cancel a newer selection');
  h.charts[1].resolve(chartPacket(next)); assert.equal(await selecting, true);
  assert.equal(h.control.current.utc, next.utc); assert.deepEqual(h.renders.map(chart => chart.utc), [next.utc]);
  await h.finishLists(); assert.equal(h.control.current.utc, next.utc);
});

test('fast exact restore failure is independent of markers and cancelled failures stay silent', async () => {
  for (const cancelled of [false, true]) {
    const h = deferredRestore(), selected = event(); let valid = true;
    const restoring = h.control.restore({ opened: false, year: 2028, bodies: ['sun', 'saturn'], eventId: selected.id, event: selected }, { valid: () => valid });
    await tick(); const list = h.jobs.find(job => job.input.body === 'saturn'); list.resolve(packet(list.input, [selected])); await tick();
    assert.equal(h.charts.length, 1);
    if (cancelled) valid = false;
    h.charts[0].reject(new Error('Exact chart unavailable'));
    assert.equal(await restoring, false); assert.equal(h.control.current, null); assert.deepEqual(h.renders, []);
    assert.equal(h.control.state.loadingChart, false); assert.equal(h.control.state.pendingEvent, null);
    assert.equal(h.control.state.chartError, cancelled ? '' : 'Exact chart unavailable');
    await h.finishLists();
    if (!cancelled) {
      const retrying = h.control.retry(); await tick(); assert.equal(h.charts.length, 2);
      h.charts[1].resolve(chartPacket(selected)); assert.equal(await retrying, true); assert.equal(h.control.current.utc, selected.utc);
    }
  }
});

test('a failed remembered chart retains the current preview and a malformed descriptor uses the legacy lookup', async () => {
  const previous = event(), selected = event('saturn', '2057-07-21T12:36:05Z');
  const { control } = fast({ client: { events: async input => packet(input, input.body === 'saturn' ? [previous, selected] : []), chart: async input => {
    if (input.eventUtc === selected.utc) throw new Error('Exact chart unavailable');
    return chartPacket(previous);
  } } });
  await control.select(natal()); await control.selectEvent(previous.id);
  const shown = control.current;
  assert.equal(await control.restore({ opened: false, bodies: [...cycles.DEFAULT_CYCLE_BODIES], eventId: selected.id, event: selected }), false);
  assert.equal(control.current, shown); assert.equal(control.state.selectedEvent, previous);
  assert.equal(control.state.chartError, 'Exact chart unavailable');

  const fallback = fast(); fallback.control.select(natal());
  assert.equal(await fallback.control.restore({ opened: false, bodies: [...cycles.DEFAULT_CYCLE_BODIES], eventId: previous.id,
    event: { ...previous, body: 'unknown' } }), true);
  assert.equal(fallback.calls.length, majorBodies.length); assert.equal(fallback.control.current.utc, previous.utc);
  assert.equal(fallback.control.state.selectedEvent.body, 'saturn');
});

test('restoring a legacy exact return after age 100 clears and acknowledges only its preview', async () => {
  const late = { ...event('saturn', '2117-04-01T12:00:00Z'), cycle: 4, cycleId: 'saturn:4' };
  for (const descriptor of [true, false]) {
    const charts = [], { control, calls } = fast({ client: {
      events: async input => { calls.push(input); return packet(input, []); },
      chart: async input => { charts.push(input); return chartPacket(late); },
    } });
    control.select(natal());
    const restored = await control.restore({ opened: true, year: 2117, bodies: ['saturn'], eventId: late.id,
      ...(descriptor ? { event: late } : {}) });
    assert.equal(restored, true, 'a discarded selection must not remain a pending restore');
    assert.deepEqual(charts, []);
    assert.equal(control.state.opened, true); assert.deepEqual(control.state.bodies, ['saturn']);
    assert.equal(control.state.year, 2100); assert.equal(control.state.selectedEvent, null); assert.equal(control.current, null);
    assert.equal(control.state.loadingChart, false); assert.equal(control.state.chartError, '');
    assert.ok(calls.every(input => input.toAge <= centuryAge));
  }
});

test('same-chart interaction cancels an exact restore without leaving a pending chart spinner', async () => {
  const selected = event(), job = deferred(); let valid = true;
  const { control } = fast({ client: { chart: () => job.promise } });
  control.select(natal()); const restoring = control.restore({ opened: false, year: 2028, bodies: [...cycles.DEFAULT_CYCLE_BODIES], eventId: selected.id }, { valid: () => valid });
  await tick(); assert.equal(control.state.loadingChart, true);
  valid = false; job.resolve(chartPacket(selected)); assert.equal(await restoring, false);
  assert.equal(control.current, null); assert.equal(control.state.pendingEvent, null); assert.equal(control.state.loadingChart, false);
  assert.equal(control.state.opened, false);
});


test('a rejected cancelled restoration cannot publish a stale chart error or retry event', async () => {
  const selected = event(), job = deferred(); let valid = true;
  const { control } = fast({ client: { chart: () => job.promise } });
  control.select(natal()); const restoring = control.restore({ opened: false, year: 2028, bodies: [...cycles.DEFAULT_CYCLE_BODIES], eventId: selected.id }, { valid: () => valid });
  await tick(); valid = false; job.reject(new Error('stale failure')); await restoring;
  assert.equal(control.state.chartError, ''); assert.equal(control.state.loadingChart, false); assert.equal(control.state.pendingEvent, null);
});


test('return range includes the final available day without crossing the ephemeris boundary', () => {
  const year = 365.2425 * 86400000, end = Date.UTC(2400, 0, 1);
  for (const utc of ['2300-12-31T00:00:00Z', '2399-12-31T23:59:00Z']) {
    const range = cycles.cycleRangeForChart({ utc });
    const last = Date.parse(utc) + range.toAge * year;
    assert.ok(last >= end - 2 && last < end, 'the range must include the final available second');
    assert.ok(range.toAge > 0 && range.toAge <= 100);
  }
});

test('one return policy separates elapsed search ages from local calendar years and saved-event bounds', () => {
  const yearMs = 365.2425 * 86400000, dayMs = 86400000, supportedEnd = Date.UTC(2400, 0, 1) - 1;
  for (const [utc, timezone] of [['2000-01-01T00:00:00Z', 'UTC'], ['2000-01-01T00:00:00Z', 'America/Los_Angeles'],
    ['2300-12-31T00:00:00Z', 'Pacific/Kiritimati'], ['2399-12-31T23:59:00Z', 'UTC']]) {
    const chart = { utc, timezone }, birth = Date.parse(utc), life = cycles.cycleRangeForChart(chart);
    const end = Math.min(supportedEnd, birth + life.toAge * yearMs);
    const localYear = value => Number(new Intl.DateTimeFormat('en', { timeZone: timezone, year: 'numeric' }).format(new Date(value)));
    assert.deepEqual(cycles.cycleYearBoundsForChart(chart), { minYear: localYear(birth), maxYear: Math.min(2399, localYear(end)) });
    assert.equal(cycles.cycleEventWithinRange(chart, utc), false);
    assert.equal(cycles.cycleEventWithinRange(chart, new Date(end).toISOString()), true);
    assert.equal(cycles.cycleEventWithinRange(chart, new Date(end + dayMs).toISOString()), false);
  }
  assert.equal(cycles.cycleEventWithinRange({ utc: '2000-01-01T00:00:00Z' }, 'bad'), false);
});

test('fast restoration adopts the validated event instead of an old saved cycle label', async () => {
  const correct = event(), saved = { ...correct, cycle: 2, cycleId: 'saturn:2' };
  const { control } = fast({ client: { chart: async () => chartPacket(correct) } });
  control.select(natal());
  await control.restore({ eventId: saved.id, event: saved, opened: false });
  assert.equal(control.state.selectedEvent.cycle, 1);
  assert.match(caption(control), /Сатурна 1$/);
});


test('return search reaches the calendar centenary and never admits a later instant', () => {
  const yearMs = 365.2425 * 86400000;
  for (const [birth, anniversary] of [
    ['2000-01-01T00:00:00Z', '2100-01-01T00:00:00Z'],
    ['2000-02-29T12:34:56Z', '2100-02-28T12:34:56Z'],
    ['2099-12-31T23:59:00Z', '2199-12-31T23:59:00Z'],
  ]) {
    const chart = { utc: birth, timezone: 'UTC' }, range = cycles.cycleRangeForChart(chart);
    assert.ok(Math.abs(Date.parse(birth) + range.toAge * yearMs - Date.parse(anniversary)) < 1, birth);
    assert.equal(cycles.cycleEventWithinRange(chart, anniversary), true, 'the exact hundredth anniversary belongs to the span');
    assert.equal(cycles.cycleEventWithinRange(chart, new Date(Date.parse(anniversary) + 1).toISOString()), false, 'the next millisecond does not');
  }
});

test('return year choices include birth year plus one hundred even for January first', async () => {
  for (const [utc, timezone, minYear, maxYear] of [
    ['2000-01-01T00:00:00Z', 'UTC', 2000, 2100],
    ['2000-01-01T00:00:00Z', 'America/Los_Angeles', 1999, 2099],
    ['1999-12-31T23:59:00Z', 'Pacific/Kiritimati', 2000, 2100],
    ['2299-12-31T12:00:00Z', 'UTC', 2299, 2399],
  ]) {
    const { control } = fast(); control.select(natal({ utc, timezone }));
    assert.equal(control.state.minYear, minYear); assert.equal(control.state.maxYear, maxYear);
    await control.setYear(maxYear); assert.equal(control.state.year, maxYear);
    await control.setYear(maxYear + 1); assert.equal(control.state.year, maxYear);
  }
});
