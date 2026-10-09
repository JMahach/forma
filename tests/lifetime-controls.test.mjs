import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { attachLifetimeControls } from '../src/views/lifetime-controls.js';
import { lifetimeChartAt } from '../src/domain/lifetime.js';
import { LIFETIME_PLANETS } from '../shared/lifetime-format.js';
import { createLocalDayTimeline, timelineIndexAt } from '../src/domain/day-timeline.js';
import { completedAge } from '../src/domain/personal-age.js';
import { dateDom } from './helpers/date-dom.mjs';

const metadata = { startUtc: '1801-01-01T00:00:00Z', endExclusiveUtc: '2400-01-01T00:00:00Z',
  stepSeconds: 600, samples: 31_504_320, planets: [...LIFETIME_PLANETS] };
const point = index => ({ index, utc: new Date(Date.parse(metadata.startUtc) + index * 600_000).toISOString(),
  longitudes: LIFETIME_PLANETS.map((_, column) => (column * 30 + index / 100_000) % 360) });
const moment = index => { const value = point(index); return { ...value, design: { utc: value.utc,
  designUtc: new Date(Date.parse(value.utc) - 88 * 86400000).toISOString(),
  designArcResidualDegrees: 1e-10, longitudes: point(0).longitudes } }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function harness(options = {}) {
  const document = dateDom();
  const elements = Object.fromEntries(['toggle', 'panel', 'range', 'hourMarks', 'fromDate', 'toDate', 'fromError', 'toError', 'fromCalendar', 'toCalendar', 'marker', 'status'].map(name => [name, document.createElement(name.endsWith('Date') ? 'input' : 'div')]));
  elements.fromDate.id = 'from'; elements.toDate.id = 'to';
  elements.range.parentElement = document.createElement('div');
  const marks = [document.createElement('span'), document.createElement('span')];
  elements.panel.querySelectorAll = selector => selector === '[data-lifetime-date]' ? marks : [];
  const utc = '2026-09-30T12:37:00Z'; let now = Date.parse(utc);
  let day = { timeline: createLocalDayTimeline(Date.parse(utc), 'Europe/Moscow'),
    wanted: true, status: 'ready', index: 937, referenceIndex: 937, live: true,
    current: { ...lifetimeChartAt(metadata, point(0)), id: 'current-transit', utc, birthDate: '2026-09-30' } };
  const requests = [], notifications = [], dayScrubs = [], dayReturns = [];
  const explorer = attachLifetimeControls({ ...elements, getDayState: () => day, now: () => now, ...options,
    onDayScrub: value => dayScrubs.push(value), onDayNow: (...args) => dayReturns.push(args),
    client: { async getMeta() { return options.metaPromise || metadata; },
      getPoint(index) { const request = { index, ...deferred() }; requests.push(request); return request.promise; },
      ...options.client,
    },
    onStateChange(state) { notifications.push({ opened: state.opened, status: state.status }); },
  });
  function type(input, value) { input.focus(); input.value = value; input.setSelectionRange(value.length, value.length); input.dispatch('input'); }
  return { ...elements, marks, explorer, requests, notifications, document, type, dayScrubs, dayReturns,
    get day() { return day; },
    setDayState(overrides) { day = { ...day, ...overrides }; explorer.syncTransit(); },
    setNow(utc) { now = Date.parse(utc); explorer.syncClock(); },
    setDay(utc, timeZone = 'Europe/Moscow') {
      const timeline = createLocalDayTimeline(Date.parse(utc), timeZone);
      day = { ...day, timeline, index: timelineIndexAt(timeline, Date.parse(utc)),
        current: { ...day.current, utc, birthDate: timeline.date } }; explorer.syncTransit();
    } };
}
async function complete(h, position = h.requests.length - 1) { const request = h.requests[position]; request.resolve(moment(request.index)); await tick(); }
async function open(h) { await h.explorer.open(); assert.equal(h.explorer.state.mode, 'day'); }
async function dates(h, from = '11081998', to = '12081998') { h.type(h.fromDate, from); h.type(h.toDate, to); await tick(); }

test('chronicle retry feedback is silent twice, centered after the third failure and clears on recovery', async () => {
  const h = harness(); await open(h);
  for (const retryCount of [0, 1, 2]) {
    h.setDayState({ status: 'loading', retryCount });
    assert.equal(h.status.textContent, '', `failure ${retryCount} stays quiet`);
  }
  h.setDayState({ status: 'loading', retryCount: 3 });
  assert.equal(h.status.textContent, 'Загружаю момент');
  assert.equal(h.panel.getAttribute('aria-busy'), 'true');
  assert.equal(h.range.parentElement.hidden, false);
  h.setDayState({ status: 'ready', retryCount: 0 });
  assert.equal(h.status.textContent, '');
  h.explorer.close();
});

test('chronicle has no manual retry button or overlapping error layout', async () => {
  const html = await fs.readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  const css = await fs.readFile(new URL('../public/styles.css', import.meta.url), 'utf8');
  assert.doesNotMatch(html, /id="lifetimeRetry"/);
  assert.doesNotMatch(css, /#lifetimeRetry/);
  assert.match(css, /\.lifetime-controls > \.lifetime-status[^{}]*\{[^}]*left: 50%[^}]*pointer-events: none/s);
});

test('hour marks belong only to the day view and disappear before a multi-day chart loads', async () => {
  const h = harness(); await open(h);
  assert.equal(h.hourMarks.children.length, 25);
  h.setDay('2026-11-01T12:00:00Z', 'America/New_York');
  assert.equal(h.hourMarks.children.length, 26);
  await dates(h);
  assert.equal(h.explorer.state.mode, 'lifetime');
  assert.equal(h.hourMarks.children.length, 0);
  await complete(h);
  assert.equal(h.hourMarks.children.length, 0);
});

test('lifetime rail keeps accessible time and date endpoints without its own visible clock', async () => {
  const h = harness({ date: undefined, time: undefined });
  await open(h);
  assert.match(h.range.getAttribute('aria-valuetext'), /15:37, UTC\+3/);
  assert.equal(h.fromDate.value, '30.09.2026');
});

test('a visible year changes only rail bounds and hides a shown moment outside that window', async () => {
  const h = harness(); await open(h); await dates(h, '11081998', '12081999'); await complete(h);
  h.explorer.scrub(Date.parse('1998-08-11T12:00:00Z')); await tick(); await complete(h);
  const current = h.explorer.current, before = h.explorer.state.requestedUtc, requests = h.requests.length;
  const window = { minUtc: Date.parse('1999-01-01T00:00:00Z'), maxUtc: Date.parse('1999-08-12T23:59:59Z') };
  h.explorer.setVisibleWindow(window);
  assert.equal(h.explorer.current, current);
  assert.equal(h.explorer.state.requestedUtc, before);
  assert.equal(h.requests.length, requests, 'a filter is not a new chart request');
  assert.equal(Number(h.range.min), window.minUtc); assert.equal(Number(h.range.max), window.maxUtc);
  assert.equal(h.range.getAttribute('data-cursor-visible'), 'false');
  h.range.dispatch('keydown', { key: 'ArrowRight' });
  assert.equal(h.explorer.state.requestedUtc, window.minUtc, 'keyboard input enters the visible year');
  h.explorer.setVisibleWindow(null);
  assert.equal(Number(h.range.min), h.explorer.state.minUtc);
  assert.equal(h.range.getAttribute('data-cursor-visible'), 'true');
});

test('only accepted timeline gestures interrupt restoration while opening and retry retain it', async () => {
  let interruptions = 0;
  const h = harness({ onMomentInput: () => { interruptions++; } }); await open(h);
  assert.equal(interruptions, 0);
  h.range.value = '100'; h.range.dispatch('input');
  assert.deepEqual(h.dayScrubs, [100]); assert.equal(interruptions, 1);
  h.marker.dispatch('click', { detail: 0 });
  assert.deepEqual(h.dayReturns, [[]]); assert.equal(interruptions, 2);
  h.setDayState({ status: 'error', error: 'Offline', retryCount: 1 });
  assert.equal(h.dayReturns.length, 1); assert.equal(interruptions, 2, 'Automatic recovery retains the same target');
  h.setDayState({ status: 'ready', error: '' });
  h.fromCalendar.dispatch('click'); const calendar = h.document.body.children[0];
  calendar.all(node => node.tagName === 'button' && node.textContent === '2026')[0].dispatch('click');
  assert.equal(interruptions, 2, 'browsing the calendar has not accepted a range');
  h.document.dispatch('pointerdown', { target: h.document.body });
  assert.equal(interruptions, 3, 'committing a calendar range is a moment command');
  assert.equal(h.explorer.state.fromDate, '2026-01-01');
  await tick(); await complete(h);
});

test('Lifetime view updates its panel without overwriting the navigation-owned toolbar action', async () => {
  const h = harness();
  h.toggle.title = 'Возвраты';
  h.toggle.setAttribute('aria-expanded', 'true'); h.toggle.setAttribute('aria-pressed', 'true');
  await h.explorer.open(); h.explorer.close();
  assert.equal(h.panel.hidden, true);
  assert.equal(h.toggle.title, 'Возвраты');
  assert.equal(h.toggle.getAttribute('aria-expanded'), 'true');
  assert.equal(h.toggle.getAttribute('aria-pressed'), 'true');
});

test('opening owns a visible day slider and delegates exact minute/Now actions with no lifetime point request', async () => {
  const h = harness(); assert.equal(h.panel.hidden, true); await open(h);
  assert.equal(h.panel.hidden, false); assert.equal(h.panel.dataset.mode, 'day');
  assert.equal(h.range.disabled, false); assert.equal(h.range.hidden, false); assert.equal(h.range.parentElement.hidden, false);
  assert.deepEqual([h.range.min, h.range.max, h.range.value, h.range.step], ['0', '1439', '937', '1']);
  assert.equal(h.fromDate.value, '30.09.2026'); assert.equal(h.toDate.value, '30.09.2026');

  assert.equal(h.marker.hidden, false); assert.equal(h.requests.length, 0);
  assert.equal(h.marker.getAttribute('aria-pressed'), 'true');
  h.range.value = '100'; h.range.dispatch('input'); assert.deepEqual(h.dayScrubs, [100]); assert.equal(h.requests.length, 0);
  h.marker.dispatch('click', { detail: 0 }); assert.deepEqual(h.dayReturns, [[]]); assert.deepEqual(h.dayScrubs, [100]);
  h.setDay('2026-09-30T12:38:00Z');
  assert.deepEqual(h.marks.map(mark => mark.textContent), ['', '']);
});

test('borrowed day reference lights on manual arrival and clears when the accepted chart leaves', async () => {
  const h = harness(); await open(h);
  h.setDayState({ live: false }); assert.equal(h.marker.getAttribute('aria-pressed'), 'true');
  const current = h.day.current;
  h.setDayState({ live: true, current: { ...current, utc: '2026-09-30T12:36:00Z' } });
  assert.equal(h.marker.getAttribute('aria-pressed'), 'false');
  h.setDayState({ live: false, current }); assert.equal(h.marker.getAttribute('aria-pressed'), 'true');
  h.setDayState({ referenceIndex: 938 }); assert.equal(h.marker.getAttribute('aria-pressed'), 'false');
  assert.deepEqual(h.dayReturns, []);
});

test('personal reference uses accepted UTC during manual, pending and failed return states', async () => {
  let owner = null;
  const h = harness({ getMomentState: () => owner });
  await open(h); await dates(h, '29092026', '01102026'); await complete(h);
  for (const status of ['ready', 'loading', 'error']) {
    owner = { ...h.day, status, live: false, requestedUtc: Date.parse('2026-09-30T13:00:00Z') };
    h.explorer.syncTransit(); assert.equal(h.marker.getAttribute('aria-pressed'), 'true', status);
    owner = { ...owner, live: true, requestedUtc: h.explorer.state.referenceUtc,
      current: { ...owner.current, utc: '2026-09-30T12:38:00Z' } };
    h.explorer.syncTransit(); assert.equal(h.marker.getAttribute('aria-pressed'), 'false', status);
  }
  owner = null; h.explorer.close();
});

test('ordinary chronicle activates only after the requested reference is actually displayed', async () => {
  const h = harness(); await open(h); await dates(h, '29092026', '01102026'); await complete(h);
  h.setNow('2026-09-30T12:40:00Z');
  h.explorer.scrub(h.explorer.state.referenceUtc); await tick();
  assert.equal(h.marker.getAttribute('aria-pressed'), 'false');
  await complete(h); assert.equal(h.marker.getAttribute('aria-pressed'), 'true');
  h.explorer.scrub(h.explorer.state.referenceUtc + 600000); await tick();
  assert.equal(h.marker.getAttribute('aria-pressed'), 'true', 'pending target has not replaced the chart');
  await complete(h); assert.equal(h.marker.getAttribute('aria-pressed'), 'false');
});

test('one transit update synchronizes the borrowed day and notifies the controls once', async () => {
  const h = harness(); await open(h);
  const next = { ...h.day.current, utc: '2026-09-30T12:38:00Z' };
  h.notifications.length = 0;
  h.setDayState({ current: next, index: 938, referenceIndex: 938 });
  assert.equal(h.explorer.current.utc, next.utc);

  assert.equal(h.notifications.length, 1);
});
test('lifetime range owns its sampled clock and current marker; today-to-today restores the exact day', async () => {
  const h = harness(); await open(h); await dates(h, '29092026', '01102026'); await complete(h);
  assert.equal(h.range.disabled, false); assert.equal(h.range.hidden, false); assert.equal(h.range.parentElement.hidden, false);
  assert.equal(h.marker.hidden, false);
  assert.equal(h.marker.getAttribute('aria-pressed'), 'false');
  h.setNow('2026-09-30T12:48:00Z'); assert.equal(h.marker.getAttribute('aria-pressed'), 'false');
  h.marker.dispatch('click', { detail: 0 }); await tick(); await complete(h);
  const requests = h.requests.length; await dates(h, '30092026', '30092026');
  assert.equal(h.explorer.state.mode, 'day');
  assert.equal(h.range.hidden, false); assert.equal(h.marker.hidden, false); assert.equal(h.requests.length, requests);
  assert.deepEqual([h.range.min, h.range.max, h.range.value], ['0', '1439', '937']);
  assert.deepEqual(h.dayScrubs, []); assert.deepEqual(h.dayReturns, [], 'lifetime reference never invokes day Now');
  h.range.value = '120'; h.range.dispatch('input'); assert.deepEqual(h.dayScrubs, [120]);
});

test('personal live lifetime clock borrows each exact day minute without requesting lifetime points', async () => {
  let liveState = null, nowCalls = 0;
  const h = harness({ getMomentState: () => liveState,
    onLifetimeNow: () => { nowCalls++; return true; } });
  await open(h); await dates(h, '29092026', '01102026'); await complete(h);
  assert.equal(h.marker.hidden, false, 'the current-time reference remains on the rail');
  const requests = h.requests.length;
  liveState = h.day; h.explorer.syncTransit();

  assert.match(h.range.getAttribute('aria-valuetext'), /12:37/);
  assert.equal(h.marker.getAttribute('aria-pressed'), 'true');
  liveState = { ...liveState, current: { ...liveState.current, utc: '2026-09-30T12:38:00Z' } };
  h.explorer.syncTransit();

  assert.equal(h.requests.length, requests);
  h.marker.dispatch('click', { detail: 0 });
  assert.equal(nowCalls, 1);
  assert.equal(h.requests.length, requests, 'live Now is not a lifetime scrub');
  liveState = { ...liveState, status: 'error', error: 'Текущий день недоступен' }; h.explorer.syncTransit();
  assert.equal(h.status.textContent, '');
  assert.equal(nowCalls, 1, 'feedback does not reselect the live moment');
  assert.equal(h.requests.length, requests, 'retry stays with the failed live owner');
  liveState = null; h.explorer.syncTransit();

  h.range.value = String(h.explorer.state.requestedUtc + 600000); h.range.dispatch('input');
  await tick(); await complete(h);

});

test('an exact return aligns the lifetime and its precise clock without fetching a rounded point', async () => {
  let owner = null;
  const h = harness({ getMomentState: () => owner, beforeScrub: () => { owner = null; } });
  await open(h);
  const utc = '2026-09-30T12:37:29.432Z';
  owner = { current: { ...h.day.current, utc }, status: 'ready', live: false };
  const index = Math.round((Date.parse(utc) - Date.parse(metadata.startUtc)) / 600000);
  const restoring = h.explorer.restore({ opened: true, mode: 'lifetime', fromDate: '2026-09-29', toDate: '2026-10-01', index });
  await tick(); assert.equal(h.requests.length, 0); assert.equal(await restoring, true);
  assert.equal(h.range.value, String(Date.parse(utc)));

  assert.match(h.range.getAttribute('aria-valuetext'), /12:37:29\.432/);
  assert.doesNotMatch(h.range.getAttribute('aria-valuetext'), /не показано|загружается/);
  assert.equal(h.marker.getAttribute('aria-pressed'), 'false');
  h.range.dispatch('input'); await tick();
  assert.equal(h.requests.length, 1, 'manual selection of the aligned slot still chooses its grid sample');
  await complete(h);

});

test('a borrowed live minute has the same exact UTC position in the control and lifetime state', async () => {
  let owner = null;
  const h = harness({ getMomentState: () => owner });
  await open(h); owner = h.day;
  const index = Math.round((Date.parse(owner.current.utc) - Date.parse(metadata.startUtc)) / 600000);
  await h.explorer.restore({ opened: true, mode: 'lifetime', fromDate: '2026-09-29', toDate: '2026-10-01', index });

  assert.equal(h.explorer.state.requestedUtc, Date.parse(owner.current.utc)); assert.equal(Number(h.range.value), h.explorer.state.requestedUtc);
  owner = { ...owner, current: { ...owner.current, utc: '2026-09-30T12:38:00Z' } };
  h.explorer.alignMoment(owner.current); h.explorer.syncTransit();
  assert.equal(Number(h.range.value), h.explorer.state.requestedUtc);
  assert.equal(h.requests.length, 0);
});

test('Lifetime day range follows real short/long local days and readiness/reference updates without a new chart', async () => {
  const h = harness(); await open(h);
  for (const [utc, minutes] of [['2026-03-08T16:00:00Z', 1380], ['2026-11-01T17:00:00Z', 1500]]) {
    h.setDay(utc, 'America/New_York');
    h.setDayState({ referenceIndex: minutes - 1, index: 90, live: false });
    assert.equal(h.range.max, String(minutes - 1)); assert.equal(h.range.value, '90');
    assert.equal(h.marker.style.left, '100%'); assert.equal(h.marker.getAttribute('aria-pressed'), 'false');
    const chart = h.day.current;
    h.setDayState({ status: 'loading' });
    assert.equal(h.day.current, chart); assert.equal(h.range.disabled, true); assert.equal(h.range.hidden, false);
    assert.equal(h.range.parentElement.hidden, false); assert.equal(h.marker.hidden, true);
    assert.equal(h.panel.getAttribute('aria-busy'), 'true'); assert.equal(h.status.textContent, '');
    h.range.dispatch('input'); h.marker.dispatch('click', { detail: 0 });
    assert.deepEqual(h.dayScrubs, []); assert.deepEqual(h.dayReturns, []);
    h.setDayState({ status: 'error', error: 'Недоступен текущий день' });
    assert.equal(h.range.disabled, true); assert.equal(h.panel.dataset.status, 'error'); assert.equal(h.status.textContent, '');
    assert.deepEqual(h.dayReturns.splice(0), []); assert.equal(h.requests.length, 0);
    h.setDayState({ status: 'ready', error: '', referenceIndex: 300 });
    assert.equal(h.day.current, chart);
    assert.equal(h.range.disabled, false); assert.equal(h.marker.hidden, false); assert.equal(h.marker.style.left, `${300 / (minutes - 1) * 100}%`);
    assert.equal(h.range.getAttribute('aria-valuetext').includes('01:30'), true);
  }
});

test('the ready day slider works before lifetime metadata arrives and closed controls never delegate input', async () => {
  const meta = deferred(), h = harness({ metaPromise: meta.promise });
  const opening = h.explorer.open();
  assert.equal(h.range.hidden, false); assert.equal(h.range.disabled, false); assert.equal(h.fromCalendar.disabled, true);
  h.range.value = '42'; h.range.dispatch('input'); assert.deepEqual(h.dayScrubs, [42]);
  h.explorer.close(); const lastValue = h.range.value;
  assert.equal(h.panel.hidden, true); assert.equal(h.marker.hidden, true);
  h.range.dispatch('input'); h.marker.dispatch('click', { detail: 0 });
  h.setDayState({ index: 88 }); assert.equal(h.range.value, lastValue, 'closed view does not redraw on day state changes');
  assert.deepEqual(h.dayScrubs, [42]); assert.deepEqual(h.dayReturns, []);
  meta.resolve(metadata); await opening;
});
test('day date follows local midnight rather than the lifetime UTC date', async () => {
  const h = harness(); await open(h); h.setDay('2026-09-30T23:57:00Z', 'Asia/Tokyo');

  assert.equal(h.fromDate.value, '01.10.2026'); assert.equal(h.toDate.value, '01.10.2026'); assert.equal(h.requests.length, 0);
});

test('reused day labels retain drafts and refresh readiness, reference and resized slider input', async () => {
  const h = harness(); await open(h);
  const writes = [];
  for (const [name, property] of [['status', 'textContent'], ['fromDate', 'value'], ['toDate', 'value']]) {
    let value = h[name][property];
    Object.defineProperty(h[name], property, { get: () => value, set(next) { value = next; writes.push(name); } });
  }
  const notices = h.notifications.length;
  h.explorer.syncTransit(); h.setDayState({ referenceIndex: 940, live: false });
  assert.deepEqual(writes, []);
  assert.equal(h.notifications.length, notices + 2, 'text reuse cannot suppress owner notifications');
  assert.equal(h.marker.style.left, `${940 / 1439 * 100}%`);
  h.setDayState({ status: 'loading' });
  assert.deepEqual(writes.splice(0), []); assert.equal(h.range.disabled, true);
  h.setDayState({ status: 'error', error: 'Нет сети', retryCount: 3 });
  assert.deepEqual(writes.splice(0), ['status']); h.type(h.fromDate, '1508'); writes.length = 0;
  h.setDayState({ status: 'ready', error: '' }); h.explorer.syncTransit();
  assert.equal(h.fromDate.value, '15.08');
  assert.ok(!writes.includes('fromDate') && !writes.includes('toDate'));
  assert.equal(h.range.disabled, false); for (const width of [400, 800]) {
    h.explorer.syncTransit();
    h.range.getBoundingClientRect = () => ({ left: 0, width, height: 56 });
    const event = { pointerType: 'touch', pointerId: 1, button: 0, clientX: 100, clientY: 20 };
    h.range.dispatch('pointerdown', event); h.range.dispatch('pointerup', event);
  }
  assert.deepEqual(h.dayScrubs, [315, 148], 'each drag still reads the current viewport geometry');
  h.setDay(h.day.current.utc, 'Asia/Tokyo');

  assert.equal(h.fromDate.value, '15.08');
});
test('the last year digit applies either endpoint immediately, including a second start date', async () => {
  const h = harness(); await open(h);
  for (const value of ['2', '22', '221', '2211', '22111', '221119', '2211199']) {
    h.type(h.fromDate, value);
    assert.equal(h.explorer.state.fromDate, '2026-09-30');
    assert.equal(h.status.textContent, '');
    assert.equal(h.requests.length, 0);
  }
  h.type(h.fromDate, '22111999');
  assert.equal(h.explorer.state.fromDate, '1999-11-22', 'no Enter, blur, or right-field edit');
  assert.equal(h.document.activeElement, h.fromDate);
  assert.equal(h.fromDate.selectionStart, 10);
  await tick(); await complete(h);
  h.type(h.fromDate, '2211199');
  assert.equal(h.explorer.state.fromDate, '1999-11-22');
  h.type(h.fromDate, '22111998');
  assert.equal(h.explorer.state.fromDate, '1998-11-22');
  h.type(h.fromDate, '22111999');
  assert.equal(h.explorer.state.fromDate, '1999-11-22', 'a repeated replacement applies too');
  h.type(h.toDate, '2311199');
  assert.equal(h.explorer.state.toDate, '2026-09-30');
  h.type(h.toDate, '23111999');
  assert.equal(h.explorer.state.toDate, '1999-11-23');
  assert.equal(h.document.activeElement, h.toDate);
  await tick(); await complete(h);
  assert.match(h.explorer.current.utc, /^1999-11-23/);
});

test('a second complete date wins over an earlier response without moving focus', async () => {
  const h = harness(); await open(h); await dates(h);
  const shown = h.explorer.current;
  h.type(h.fromDate, '2211199');
  assert.equal(h.requests.length, 1);
  assert.equal(h.explorer.state.fromDate, '1998-08-11');
  h.type(h.fromDate, '22111999');
  assert.equal(h.explorer.state.fromDate, '1999-11-22');
  assert.equal(h.explorer.state.openEnded, true);
  await complete(h, 0);
  assert.equal(h.explorer.current, shown, 'the superseded response cannot become the chart');
  assert.equal(h.requests.length, 2);
  await complete(h, 1);
  assert.match(h.explorer.current.utc, /^1999-11-22/);
  assert.equal(h.fromDate.value, '22.11.1999');
  assert.equal(h.document.activeElement, h.fromDate);
});

test('Tab retains the applied start and selects the end; its last digit applies the inclusive pair', async () => {
  const h = harness(); await open(h); h.type(h.fromDate, '11081998'); h.fromDate.dispatch('change');
  assert.equal(h.explorer.state.fromDate, '1998-08-11');
  let prevented = false; h.fromDate.dispatch('keydown', { key: 'Tab', preventDefault() { prevented = true; } });
  assert.equal(prevented, true); assert.equal(h.document.activeElement, h.toDate);
  assert.deepEqual([h.toDate.selectionStart, h.toDate.selectionEnd], [0, 10]);
  let reversePrevented = false; h.fromDate.dispatch('keydown', { key: 'Tab', shiftKey: true, preventDefault() { reversePrevented = true; } });
  assert.equal(reversePrevented, false, 'Shift+Tab preserves native access to the calendar button');
  h.setDay('2026-09-30T12:38:00Z'); assert.equal(h.fromDate.value, '11.08.1998'); assert.equal(h.requests.length, 0);
  h.type(h.toDate, '12081998'); await tick();
  assert.equal(h.explorer.state.fromDate, '1998-08-11'); assert.equal(h.explorer.state.toDate, '1998-08-12');
  assert.equal(Number(h.range.max) - Number(h.range.min) + 1, 172800000);
  assert.equal(h.marker.hidden, true); await complete(h);
  assert.deepEqual(h.marks.map(mark => mark.textContent), ['11.08.1998', '12.08.1998']);
});
test('focus and click select the entire formatted date, including after caret placement', async () => {
  const h = harness(); await open(h);
  for (const input of [h.fromDate, h.toDate]) {
    input.focus(); assert.deepEqual([input.selectionStart, input.selectionEnd], [0, 10]);
    input.setSelectionRange(3, 3); input.dispatch('click'); assert.deepEqual([input.selectionStart, input.selectionEnd], [0, 10]);
  }
});
test('invalid calendar dates stay inside their own field with two words', async () => {
  const h = harness(); await open(h);
  const current = h.explorer.current;
  h.type(h.fromDate, '11221999');
  assert.equal(h.fromError.textContent, 'Дата некорректна');
  assert.equal(h.toError.textContent, '');
  assert.equal(h.fromDate.getAttribute('aria-invalid'), 'true');
  assert.equal(h.status.textContent, '', 'no validation paragraph above the timeline');
  h.setDay('2026-09-30T12:38:00Z');
  assert.equal(h.fromError.textContent, 'Дата некорректна');
  h.type(h.toDate, '31022026');
  assert.equal(h.toError.textContent, 'Дата некорректна');
  assert.equal(h.fromError.textContent, 'Дата некорректна');
  h.type(h.fromDate, '22111999');
  assert.equal(h.fromError.textContent, '');
  assert.equal(h.toError.textContent, 'Дата некорректна');
  assert.equal(h.explorer.state.mode, 'day');
  assert.equal(h.requests.length, 0);
  h.type(h.toDate, '');
  assert.equal(h.toError.textContent, '');
  assert.equal(h.explorer.state.openEnded, true);
  await tick(); await complete(h);
});

test('valid dates outside supported bounds identify the offending endpoint', async () => {
  for (const [field, error, value] of [['fromDate', 'fromError', '01011800'], ['fromDate', 'fromError', '01012400'],
    ['toDate', 'toError', '31122400'], ['toDate', 'toError', '31121800']]) {
    const h = harness(); await open(h);
    const current = h.explorer.current;
    h.type(h[field], value);
    assert.equal(h[error].textContent, 'Вне диапазона', `${field}: ${value}`);
    assert.equal(h[field].getAttribute('aria-invalid'), 'true');
    assert.equal(h.status.textContent, '');
    assert.equal(h.explorer.current, current);
    assert.equal(h.requests.length, 0);
  }
});

test('date errors remain inside the date while repeated failures recover automatically', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = harness(); await open(h); await dates(h);
  h.type(h.toDate, '31021998');
  for (let attempt = 1; attempt <= 3; attempt++) {
    h.requests.at(-1).reject(new Error('Нет соединения')); await tick();
    assert.equal(h.toError.textContent, 'Дата некорректна');
    assert.equal(h.status.textContent, attempt < 3 ? '' : 'Загружаю момент');
    t.mock.timers.tick(1000 * 2 ** (attempt - 1)); await tick();
  }
  await complete(h);
  assert.equal(h.toError.textContent, 'Дата некорректна');
  assert.equal(h.status.textContent, ''); h.explorer.close();
});

test('metadata bounds are inclusive and late metadata validates only the current draft', async () => {
  const h = harness(); await open(h);
  h.type(h.fromDate, '01011801'); h.type(h.toDate, '31122399');
  assert.equal(h.fromError.textContent, ''); assert.equal(h.toError.textContent, '');
  assert.equal(h.explorer.state.fromDate, '1801-01-01'); assert.equal(h.explorer.state.toDate, '2399-12-31');
  await tick(); await complete(h);
  const meta = deferred(), pending = harness({ metaPromise: meta.promise });
  const opening = pending.explorer.open();
  await dates(pending, '01011800', '02111800');
  assert.equal(pending.fromError.textContent, ''); assert.equal(pending.toError.textContent, '');
  meta.resolve(metadata); await opening; await tick();
  assert.equal(pending.fromError.textContent, 'Вне диапазона');
  assert.equal(pending.toError.textContent, 'Вне диапазона');
  assert.equal(pending.requests.length, 0);
});

test('invalid, reversed, unsupported and incomplete drafts preserve the displayed point', async () => {
  for (const [field, value, reason] of [['toDate', '31021998', 'Дата некорректна'], ['toDate', '10081998', 'Вне диапазона'], ['fromDate', '01011800', 'Вне диапазона']]) {
    const h = harness(); await open(h); await dates(h); await complete(h);
    const current = h.explorer.current, count = h.requests.length;
    const accepted = [h.explorer.state.fromDate, h.explorer.state.toDate];
    h.type(h[field], value); await tick();
    assert.equal(h.requests.length, count); assert.equal(h.explorer.current, current); assert.equal(h[field === 'fromDate' ? 'fromError' : 'toError'].textContent, reason); assert.equal(h.status.textContent, '');
    assert.deepEqual([h.explorer.state.fromDate, h.explorer.state.toDate], accepted);
  }
  const h = harness(); await open(h); h.type(h.toDate, '1208'); h.toDate.dispatch('change');
  assert.equal(h.toError.textContent, 'Дата некорректна'); assert.equal(h.status.textContent, ''); assert.equal(h.toDate.getAttribute('aria-invalid'), 'true');
  h.type(h.toDate, '120'); assert.equal(h.status.textContent, '');
});
test('pending point completion and clock refresh preserve unfinished drafts in both inputs', async () => {
  const h = harness(); await open(h); await dates(h);
  h.type(h.fromDate, '15081998'); h.type(h.toDate, '1708'); h.toggle.focus(); await complete(h);
  h.setNow('2026-09-30T12:48:00Z'); assert.equal(h.fromDate.value, '15.08.1998'); assert.equal(h.toDate.value, '17.08');
});
test('a ninth pasted digit is retained and rejected instead of silently committing eight digits', async () => {
  const h = harness(); await open(h); await dates(h, '110819981', '12081998');
  assert.equal(h.fromDate.value, '110819981'); assert.equal(h.fromError.textContent, 'Дата некорректна'); assert.equal(h.status.textContent, '');
  h.toDate.dispatch('keydown', { key: 'Enter' }); assert.equal(h.requests.length, 0);
  h.type(h.fromDate, '11081998'); h.toDate.dispatch('change'); await tick(); assert.equal(h.requests.length, 1); await complete(h);
});
test('drafts entered while metadata is pending survive and apply when it becomes available', async () => {
  const meta = deferred(), h = harness({ metaPromise: meta.promise }); const opening = h.explorer.open();
  await dates(h); assert.equal(h.status.textContent, ''); assert.equal(h.fromCalendar.disabled, true);
  meta.resolve(metadata); await tick(); assert.equal(h.explorer.state.fromDate, '1998-08-11');
  await complete(h, 0); if (h.requests.length > 1) await complete(h); await opening;
  assert.equal(h.status.textContent, ''); assert.equal(h.fromDate.value, '11.08.1998');
  const pending = deferred(), changed = harness({ metaPromise: pending.promise }); const other = changed.explorer.open();
  await dates(changed); changed.type(changed.fromDate, '1508'); pending.resolve(metadata); await other; await tick(); assert.equal(changed.requests.length, 0);
  assert.equal(changed.fromDate.value, '15.08'); assert.equal(changed.explorer.state.fromDate, '2026-09-30');
});
test('Enter and unchanged change events add no request after automatic application', async () => {
  const h = harness(); await open(h); h.type(h.fromDate, '29092026');
  h.fromDate.dispatch('keydown', { key: 'Enter' }); await tick(); assert.equal(h.explorer.state.fromDate, '2026-09-29');
  const count = h.requests.length; h.toDate.dispatch('change'); await tick(); assert.equal(h.requests.length, count);
});
test('a transient scrub failure keeps the displayed chart and retries the chosen range automatically', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = harness(); await open(h); await dates(h); await complete(h);
  const before = h.explorer.current, next = Number(h.range.min) + 600000;
  h.range.value = String(next); h.range.dispatch('input'); await tick();
  h.requests.at(-1).reject(new Error('Проверка повторной загрузки')); await tick();
  assert.equal(h.explorer.current, before); assert.equal(h.status.textContent, '');
  assert.equal(h.explorer.state.retryCount, 1);
  t.mock.timers.tick(1000); await tick(); await complete(h);
  assert.equal(h.explorer.state.retryCount, 0); assert.equal(h.status.textContent, '');
  assert.equal(h.fromDate.value, '11.08.1998'); assert.equal(h.toDate.value, '12.08.1998');
  h.explorer.close();
});

test('quick lifetime requests keep the shown clock and never flash a loading message', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = harness(); await open(h); await dates(h); await complete(h);
  const shown = h.explorer.current;
  const next = Number(h.range.min) + 600000;
  h.range.value = String(next); h.range.dispatch('input'); await tick();
  assert.equal(h.requests.at(-1).index, (next - Date.parse(metadata.startUtc)) / 600000, 'the request starts without waiting for the label');
  assert.equal(h.range.value, String(next)); assert.equal(h.range.disabled, false);
  assert.equal(h.panel.getAttribute('aria-busy'), 'true');
  assert.match(h.range.getAttribute('aria-valuetext'), /загружается/);
  assert.equal(h.explorer.current, shown);
  t.mock.timers.tick(399); assert.equal(h.status.textContent, '');
  await complete(h);
  assert.equal(h.explorer.state.status, 'ready'); assert.equal(h.status.textContent, '');

  t.mock.timers.tick(1000); assert.equal(h.status.textContent, '', 'a completed request cancels its delayed label');
  h.explorer.scrub(next + 600000); await tick();
  t.mock.timers.tick(399); assert.equal(h.status.textContent, '', 'a new request receives its own delay');
  t.mock.timers.tick(1); assert.equal(h.status.textContent, '');
  await complete(h); assert.equal(h.status.textContent, '');
});

test('continuous scrubbing remains silent while requests have not failed', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = harness(); await open(h); await dates(h);
  const first = h.requests[0], notices = h.notifications.length;
  t.mock.timers.tick(200);
  h.explorer.scrub(Date.parse(point(first.index - 1).utc)); h.explorer.scrub(Date.parse(point(first.index - 2).utc));
  assert.equal(h.requests.length, 1, 'the existing one-flight request policy is unchanged');
  assert.equal(h.range.value, String(Date.parse(point(first.index - 2).utc)));
  t.mock.timers.tick(199); assert.equal(h.status.textContent, '');
  const beforeTimerNotices = h.notifications.length;
  t.mock.timers.tick(1); assert.equal(h.status.textContent, '');
  assert.ok(h.notifications.length > notices, 'state updates continue during the delay');
  assert.equal(h.notifications.length, beforeTimerNotices, 'elapsed time alone does not trigger feedback');
  t.mock.timers.tick(1000); assert.equal(h.notifications.length, beforeTimerNotices, 'elapsed time never redraws or notifies the owner');
  await complete(h, 0);
  assert.equal(h.requests.length, 2); assert.equal(h.status.textContent, '');
  assert.equal(h.explorer.state.status, 'loading', 'an intermediate displayed point does not restart the episode');
  await complete(h, 1); assert.equal(h.status.textContent, '');
});

test('close and returning to today cancel automatic retries without stale feedback', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = harness(); await open(h); await dates(h);
  h.requests.at(-1).reject(new Error('Нет соединения')); await tick();
  const count = h.requests.length;
  h.explorer.close(); t.mock.timers.tick(30000); await tick();
  assert.equal(h.requests.length, count); assert.equal(h.status.textContent, '');
  assert.equal(h.panel.hidden, true);
  await open(h); await dates(h);
  h.requests.at(-1).reject(new Error('Нет соединения')); await tick();
  const pendingCount = h.requests.length;
  await dates(h, '30092026', '30092026');
  assert.equal(h.explorer.state.mode, 'day');
  t.mock.timers.tick(30000); await tick();
  assert.equal(h.requests.length, pendingCount); assert.equal(h.status.textContent, '');
  h.explorer.close();
});

test('a delayed loading label cannot overwrite an unfinished date error', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = harness(); await open(h); await dates(h);
  h.type(h.toDate, '31021998'); const error = h.toError.textContent;
  assert.equal(error, 'Дата некорректна');
  t.mock.timers.tick(400); assert.equal(h.toError.textContent, error); assert.equal(h.status.textContent, '');
  await complete(h); assert.equal(h.toError.textContent, error); assert.equal(h.status.textContent, '');
  assert.equal(h.toDate.value, '31.02.1998');
});
test('calendar year selection commits Jan 1 for both endpoints on dismissal and keeps the current date while browsing', async () => {
  const h = harness(); await open(h);
  const click = (popup, text) => { const target = popup.all(node => node.tagName === 'button' && node.textContent === text)[0]; assert.ok(target, text); target.dispatch('click'); };
  h.fromCalendar.dispatch('click'); const from = h.document.body.children[0];
  click(from, '2026–2050'); click(from, '2001–2025'); click(from, '2025');
  assert.equal(h.fromDate.value, '30.09.2026');
  h.document.dispatch('pointerdown', { target: h.toCalendar });
  assert.equal(h.fromDate.value, '01.01.2025'); assert.equal(h.explorer.state.fromDate, '2025-01-01');
  h.document.dispatch('pointerdown', { target: h.toCalendar }); h.toCalendar.dispatch('click'); const to = h.document.body.children[1];
  click(to, '2027');
  assert.equal(h.toDate.value, '30.09.2026');
  h.document.dispatch('pointerdown', { target: h.fromDate });
  assert.equal(h.toDate.value, '01.01.2027'); assert.equal(h.explorer.state.toDate, '2027-01-01');
  h.explorer.close(); assert.equal(from.hidden, true); assert.equal(to.hidden, true);
  assert.equal(h.panel.hidden, true);
});
test('unavailable/closed controls dismiss calendars and reopen with the current day and cleared validation', async () => {
  const h = harness(); await open(h); h.type(h.toDate, '31021998'); h.fromCalendar.dispatch('click');
  h.explorer.setAvailable(false); assert.equal(h.panel.hidden, true); assert.equal(h.toggle.hidden, true);
  assert.equal(h.document.body.children.every(node => node.hidden), true); const notifications = h.notifications.length;
  h.explorer.setAvailable(false); assert.equal(h.notifications.length, notifications);
  h.explorer.setAvailable(true); h.toggle.focus(); await open(h);
  assert.equal(h.toDate.value, '30.09.2026'); assert.equal(h.toDate.getAttribute('aria-invalid'), 'false'); assert.equal(h.status.textContent, '');
});
test('Lifetime owns one visible range in either mode without overlapping the ordinary transit panel', async () => {
  const html = await fs.readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  const css = await fs.readFile(new URL('../public/styles.css', import.meta.url), 'utf8');
  for (const name of ['From', 'To']) {
    assert.ok(html.indexOf(`id="lifetime${name}Calendar"`) < html.indexOf(`id="lifetime${name}Date"`));
    assert.match(html, new RegExp(`<input id="lifetime${name}Date"[^>]*type="text"[^>]*inputmode="numeric"[^>]*maxlength="10"`));
  }
  const toggle = html.match(/<button[^>]*id="lifetimeToggle"[^>]*>[\s\S]*?<\/button>/)?.[0];
  assert.match(toggle, /aria-label="Летопись"/);
  assert.match(toggle, /<svg width="21" height="21"/);
  assert.doesNotMatch(toggle, /<span/);
  const dayToggle = html.match(/<button[^>]*id="natalDayToggle"[^>]*>[\s\S]*?<\/button>/)?.[0];
  assert.match(dayToggle, /aria-label="Шкала дня"/);
  assert.doesNotMatch(dayToggle, /<span/);
  assert.doesNotMatch(html, /id="lifetimeClose"/);
  assert.doesNotMatch(css, /#lifetimeClose/);
  assert.match(html, /class="day-reference" id="lifetimeReference"/);
  assert.doesNotMatch(css, /\.lifetime-controls\[data-mode='day'\]/);
  assert.doesNotMatch(css, /#lifetimeControls\[data-mode='day'\]/);
  assert.match(css, /\.timeline-dock\s*\{[^}]*border-top: 1px solid/, 'Lifetime uses the shared permanent divider');
  assert.match(css, /\.lifetime-heading input:focus-visible\s*\{\s*outline: none;/);

});

test('a complete start date after the end clears only the end and asynchronous updates cannot refill it', async () => {
  const h = harness(); await open(h);
  h.type(h.fromDate, '04102026');
  assert.equal(h.fromDate.value, '04.10.2026'); assert.equal(h.toDate.value, '');
  await tick(); await complete(h);
  assert.equal(h.toDate.getAttribute('aria-invalid'), 'false'); assert.equal(h.status.textContent, '');
  assert.equal(h.explorer.state.openEnded, true); assert.equal(h.explorer.state.toDate, '2399-12-31');
  assert.equal(h.range.disabled, false); assert.equal(h.range.max, String(Date.parse('2399-12-31T23:59:59.999Z')));
  assert.equal(h.marks[1].textContent, '31.12.2399');
  assert.equal(h.toDate.placeholder, 'До конца');
  h.setDay('2026-09-30T12:38:00Z');
  assert.equal(h.fromDate.value, '04.10.2026'); assert.equal(h.toDate.value, '');
  h.type(h.toDate, '06102026'); await tick(); await complete(h);
  assert.equal(h.explorer.state.fromDate, '2026-10-04'); assert.equal(h.explorer.state.toDate, '2026-10-06');
});

test('calendar start after end resets the end without committing an inverted range or showing an incomplete-date error', async () => {
  const h = harness(); await open(h); h.fromCalendar.dispatch('click');
  const popup = h.document.body.children[0];
  const click = text => { const target = popup.all(node => node.tagName === 'button' && node.textContent === text)[0]; assert.ok(target); target.dispatch('click'); };
  click('2027'); h.document.dispatch('pointerdown', { target: h.panel });
  assert.equal(h.fromDate.value, '01.01.2027'); assert.equal(h.toDate.value, '');
  await tick(); await complete(h);
  assert.equal(h.status.textContent, ''); assert.equal(h.toDate.getAttribute('aria-invalid'), 'false');
  assert.equal(h.explorer.state.openEnded, true); assert.equal(h.range.disabled, false);
});

test('equal dates and incomplete, impossible or outside-lifetime start drafts never clear the end', async () => {
  const h = harness(); await open(h);
  for (const value of ['30092026', '0410', '31022027', '01012400']) {
    h.type(h.fromDate, value); assert.equal(h.toDate.value, '30.09.2026', value);
  }
});

test('clearing the end deliberately means the final available date and entering an explicit end exits that mode', async () => {
  const h = harness(); await open(h); await dates(h, '04102026', '06102026'); await complete(h);
  h.type(h.toDate, ''); await tick();
  assert.equal(h.explorer.state.openEnded, true); assert.equal(h.explorer.state.toDate, '2399-12-31');
  assert.equal(h.toDate.value, ''); assert.equal(h.toDate.placeholder, 'До конца');
  assert.equal(h.range.disabled, false); assert.equal(h.range.max, String(Date.parse('2399-12-31T23:59:59.999Z')));
  h.type(h.toDate, '07102026'); await tick(); await complete(h);
  assert.equal(h.explorer.state.openEnded, false); assert.equal(h.explorer.state.toDate, '2026-10-07');
  assert.equal(h.toDate.value, '07.10.2026'); assert.equal(h.toDate.placeholder, 'ДД.ММ.ГГГГ');
});

test('touch scrubbing calls beforeScrub before day/lifetime actions without a native input event', async () => {
  const actions = []; let h;
  h = harness({ beforeScrub: () => actions.push({ mode: h.explorer.state.mode, index: h.explorer.state.requestedUtc, dayScrubs: h.dayScrubs.length }) });
  h.range.getBoundingClientRect = () => ({ left: 0, top: 0, width: 400, height: 44, bottom: 44 });
  let nativeInputs = 0; h.range.addEventListener('input', () => nativeInputs++);
  const pointer = { pointerId: 1, pointerType: 'touch', button: 0, clientX: 80, clientY: 22 };
  await open(h); h.range.dispatch('pointerdown', pointer); h.range.dispatch('pointerup', pointer);
  assert.equal(nativeInputs, 0); assert.equal(actions.length, 1); assert.equal(actions[0].mode, 'day');
  assert.equal(actions[0].dayScrubs, 0); assert.equal(h.dayScrubs.length, 1);
  await dates(h); await complete(h); const initial = h.explorer.state.requestedUtc;
  h.range.dispatch('pointerdown', { ...pointer, pointerId: 2 }); h.range.dispatch('pointerup', { ...pointer, pointerId: 2 });
  assert.equal(nativeInputs, 0); assert.equal(actions.length, 2); assert.equal(actions[1].mode, 'lifetime');
  assert.equal(actions[1].index, initial); assert.notEqual(h.explorer.state.requestedUtc, initial);
  const userActions = actions.length; h.explorer.scrub(h.explorer.state.requestedUtc + 600000);
  assert.equal(actions.length, userActions, 'programmatic marker alignment does not activate manual preview');
});
test('reference actions invoke beforeScrub before day Now and lifetime return to the current moment', async () => {
  const actions = []; let h;
  h = harness({ beforeScrub: () => actions.push({ mode: h.explorer.state.mode, index: h.explorer.state.requestedUtc, returns: h.dayReturns.length }) });
  await open(h); h.marker.dispatch('click', { detail: 0 });
  assert.deepEqual(actions, [{ mode: 'day', index: h.explorer.state.requestedUtc, returns: 0 }]); assert.equal(h.dayReturns.length, 1);
  await dates(h, '29092026', '01102026'); await complete(h);
  h.explorer.scrub(h.explorer.state.minUtc); await tick(); await complete(h); const oldIndex = h.explorer.state.requestedUtc;
  h.marker.dispatch('click', { detail: 0 });
  assert.equal(actions.length, 2); assert.equal(actions[1].mode, 'lifetime'); assert.equal(actions[1].index, oldIndex);
  assert.equal(h.explorer.state.requestedUtc, Date.parse('2026-09-30T12:40:00Z'));
});

test('an exact birth endpoint can own a scrub while the Now marker still supplies its actual target UTC', async () => {
  const targets = [];
  const h = harness({ beforeScrub: value => { targets.push(value); return false; } });
  await open(h); await dates(h, '29092026', '01102026'); await complete(h);
  const index = h.explorer.state.requestedUtc, requests = h.requests.length;
  h.range.value = h.range.min; h.range.dispatch('input');
  assert.equal(targets[0], h.explorer.state.minUtc);
  assert.equal(h.explorer.state.requestedUtc, index, 'the exact endpoint owner prevents an extra lifetime sample');
  assert.equal(h.requests.length, requests);
  h.setNow('2026-09-30T12:48:00Z');
  h.marker.dispatch('click', { detail: 0 });
  assert.equal(targets[1], h.explorer.state.referenceUtc, 'Now must not reuse the thumb position at birth');
  assert.equal(h.requests.length, requests);
});

test('retry feedback follows the live owner even when the lifetime is ready', async () => {
  let live = null;
  const h = harness({ getMomentState: () => live });
  await open(h); await dates(h); await complete(h);
  live = { ...h.day, status: 'error', retryCount: 2 }; h.explorer.syncTransit();
  assert.equal(h.explorer.state.status, 'ready'); assert.equal(h.status.textContent, '');
  live = { ...live, retryCount: 3 }; h.explorer.syncTransit();
  assert.equal(h.status.textContent, 'Загружаю момент');
  assert.equal(h.panel.getAttribute('aria-busy'), 'true');
  live = { ...live, status: 'ready', retryCount: 0 }; h.explorer.syncTransit();
  assert.equal(h.status.textContent, ''); h.explorer.close();
});

test('endpoint labels have one owner for personal and standalone ranges and unchanged refreshes make no text writes', async t => {
  for (const personal of [false, true]) await t.test(personal ? 'personal life' : 'standalone lifetime', async () => {
    let borrowed = null;
    const natal = { utc: '1998-08-11T12:34:56Z', timezone: 'UTC' };
    const h = harness({ getMomentState: () => borrowed,
      formatEndpoints: state => personal ? ['Рождение', `${completedAge(`${state.toDate}T23:59:59Z`, natal)} лет`] : null });
    await open(h); await dates(h); await complete(h);
    assert.deepEqual(h.marks.map(mark => mark.textContent), personal ? ['Рождение', '0 лет'] : ['11.08.1998', '12.08.1998']);
    borrowed = h.day;
    await h.explorer.setDateRange('1998-08-11', '2098-08-11');
    assert.deepEqual(h.marks.map(mark => mark.textContent), personal ? ['Рождение', '100 лет'] : ['11.08.1998', '11.08.2098']);
    let writes = 0;
    for (const mark of h.marks) {
      let value = mark.textContent;
      Object.defineProperty(mark, 'textContent', { get: () => value, set: next => { writes++; value = next; } });
    }
    for (let update = 0; update < 50; update++) h.explorer.syncTransit();
    assert.equal(writes, 0, 'the displayed range did not change');
    h.explorer.close();
    assert.deepEqual(h.marks.map(mark => mark.textContent), ['', '']);
  });
});

test('lifetime UTC keeps cached minute keyboard steps, exact boundaries and the birth owner reachable', async () => {
  const targets = [], minimumUtc = Date.parse('1998-08-11T12:34:56Z');
  let ready = null;
  const h = harness({ client: { peekMinute: utc => ready && Math.floor(utc / 60000) * 60000 === Date.parse(ready.utc) ? ready : null },
    beforeScrub: utc => { targets.push(utc); return utc !== minimumUtc; } });
  await open(h);
  const restoring = h.explorer.restore({ opened: true, mode: 'lifetime', fromDate: '1998-08-11', toDate: '1998-08-12',
    minimumUtc: '1998-08-11T12:34:56Z', requestedUtc: Date.parse('1998-08-12T12:30:00Z') });
  await tick(); await complete(h); await restoring;
  assert.equal(h.range.min, String(minimumUtc)); assert.equal(h.range.max, String(Date.parse('1998-08-12T23:59:59.999Z')));
  assert.equal(h.range.step, 'any');
  const utc = Date.parse('1998-08-12T12:31:00Z');
  ready = { ...h.day.current, utc: new Date(utc).toISOString() };
  h.range.value = String(utc); h.range.dispatch('input');
  assert.equal(h.range.value, String(utc));
  const requests = h.requests.length;
  ready = { ...ready, utc: '1998-08-12T12:32:00Z' };
  h.range.dispatch('keydown', { key: 'ArrowRight' });
  assert.equal(h.range.value, String(utc + 60000)); assert.equal(h.requests.length, requests);
  assert.equal(targets.at(-1), utc + 60000);
  h.range.dispatch('keydown', { key: 'Home' });
  assert.equal(targets.at(-1), minimumUtc, 'Home is offered to the exact birth owner before lifetime snapping');
  assert.equal(h.requests.length, requests);
  h.range.dispatch('keydown', { key: 'End' });
  assert.equal(targets.at(-1), Date.parse('1998-08-12T23:59:59.999Z'));
});

test('an unchanged cold pointer target restores its resolved UTC thumb', async () => {
  const h = harness(); await open(h); await dates(h); await complete(h);
  const accepted = Date.parse(h.explorer.current.utc);
  h.range.value = String(accepted + 120000); h.range.dispatch('input');
  assert.equal(h.range.value, String(accepted));
  assert.doesNotMatch(h.range.getAttribute('aria-valuetext'), /не показано/);
});


test('personal decade marks use real birthdays and the clipped window without relabelling its left edge', async () => {
  let personal = { utc: '2000-02-29T12:00:00Z', timezone: 'UTC' };
  const h = harness({ getPersonalChart: () => personal });
  await open(h);
  await dates(h, '29022000', '01032100');
  assert.deepEqual(h.hourMarks.children.map(mark => mark.dataset.age), ['0', '10', '20', '30', '40', '50', '60', '70', '80', '90', '100']);
  const first = h.hourMarks.children[0];
  assert.match(first.className, /is-major/);
  const birth = Date.parse(personal.utc);
  h.explorer.setVisibleWindow({ minUtc: birth, maxUtc: birth + 86400000 });
  assert.equal(h.hourMarks.children[0].style['--hour-position'], '0%');
  h.explorer.setVisibleWindow({ minUtc: birth + 1, maxUtc: birth + 86400000 });
  assert.equal(h.hourMarks.children.length, 0, 'birth uses its actual instant, not midnight or a rounded minute');
  h.explorer.setVisibleWindow(null);
  const restored = h.hourMarks.children[0];
  h.explorer.setVisibleWindow({ minUtc: Number(h.range.min), maxUtc: Number(h.range.max) });
  assert.equal(h.hourMarks.children[0], restored, 'unchanged span reuses marks');
  const minUtc = Date.parse('2010-01-01T00:00:00Z'), maxUtc = Date.parse('2011-01-01T00:00:00Z');
  h.explorer.setVisibleWindow({ minUtc, maxUtc });
  assert.deepEqual(h.hourMarks.children.map(mark => mark.dataset.age), ['10']);
  const position = Number.parseFloat(h.hourMarks.children[0].style['--hour-position']);
  assert.ok(Math.abs(position - 59 / 365 * 100) < 1e-8, '29 February reaches completed age on 1 March in a non-leap year');
  h.explorer.setVisibleWindow({ minUtc: Date.parse('2010-06-01T00:00:00Z'), maxUtc });
  assert.equal(h.hourMarks.children.length, 0, 'a clipped birthday must not move to the start of the year');
  h.explorer.setVisibleWindow(null);
  personal = null;
  h.explorer.setVisibleWindow({ minUtc, maxUtc });
  assert.equal(h.hourMarks.children.length, 0, 'ordinary chronicle never inherits personal ages');
});

test('personal marks honour the birth timezone and clear when returning to the day view', async () => {
  const h = harness({ getPersonalChart: () => ({ utc: '2000-01-01T18:00:00Z', timezone: 'Asia/Tokyo' }) });
  await open(h); await dates(h, '01012000', '31122020');
  const minUtc = Date.parse('2009-12-31T15:00:00Z'), maxUtc = Date.parse('2010-12-31T15:00:00Z');
  h.explorer.setVisibleWindow({ minUtc, maxUtc });
  assert.deepEqual(h.hourMarks.children.map(mark => mark.dataset.age), ['10']);
  assert.ok(Math.abs(Number.parseFloat(h.hourMarks.children[0].style['--hour-position']) - 1 / 365 * 100) < 1e-8, 'local 2 January begins at 15:00 UTC on 1 January');
  h.explorer.setVisibleWindow(null);
  let writes = 0;
  const replaceChildren = h.hourMarks.replaceChildren.bind(h.hourMarks);
  h.hourMarks.replaceChildren = (...children) => { writes++; replaceChildren(...children); };
  await h.explorer.setDateRange('2026-09-30', '2026-09-30');
  assert.equal(h.explorer.state.mode, 'day');
  assert.equal(h.hourMarks.children.length, 25);
  assert.ok(h.hourMarks.children.every(mark => mark.dataset.age === undefined));
  assert.equal(writes, 1, 'changing scale replaces its marks once, without a separate clearing pass');
  writes = 0;
  for (let update = 0; update < 20; update++) h.explorer.syncTransit();
  assert.equal(writes, 0, 'unchanged day updates reuse the same marks');
  void h.explorer.setDateRange('2000-01-01', '2020-12-31');
  await tick();
  assert.deepEqual(h.hourMarks.children.map(mark => mark.dataset.age), ['0', '10', '20']);
  assert.equal(writes, 1, 'returning to the same life span restores its marks in one replacement');
});

test('reference titles distinguish the current moment from a personal transit', async () => {
  let personal = null, owner = null;
  const h = harness({ getPersonalChart: () => personal, getMomentState: () => owner });
  await open(h); assert.equal(h.marker.title, 'Текущий момент');
  await dates(h, '29092026', '01102026'); await complete(h);
  assert.equal(h.marker.title, 'Текущий момент');
  personal = { utc: '1998-08-18T14:00:00Z', timezone: 'Europe/Moscow' }; owner = h.day;
  h.explorer.syncTransit(); assert.equal(h.marker.title, 'Текущий транзит');
});


test('preparing keeps the disabled lifetime rail and stays visible through live-day updates until a fresh request succeeds', async () => {
  let ready = false, requests = 0;
  const h = harness({ client: { async getMeta() {
    requests++;
    if (!ready) throw Object.assign(new Error('Создаём летопись'), { code: 'lifetime_preparing' });
    return metadata;
  } } });
  await h.explorer.open();
  assert.equal(h.toggle.hidden, false);
  assert.equal(h.panel.hidden, false);
  assert.equal(h.explorer.state.status, 'preparing');
  assert.equal(h.status.textContent, 'Создаём летопись');
  assert.equal(h.panel.getAttribute('aria-busy'), 'true');
  assert.equal(h.range.parentElement.hidden, false);
  assert.equal(h.range.hidden, false);
  assert.equal(h.marker.hidden, true);
  assert.equal(h.range.disabled, true);
  h.range.dispatch('input');
  assert.deepEqual(h.dayScrubs, [], 'the visible rail is not interactive before preparation finishes');
  assert.equal(h.fromDate.disabled, true);
  assert.equal(h.toDate.disabled, true);
  assert.equal(h.fromCalendar.disabled, true);
  assert.equal(h.toCalendar.disabled, true);
  assert.equal(h.fromDate.value, '30.09.2026');
  assert.equal(h.toDate.value, '30.09.2026');
  h.setDay('2026-09-30T12:38:00Z');
  h.setDayState({ status: 'loading' });
  assert.equal(h.explorer.state.status, 'preparing');
  assert.equal(h.status.textContent, 'Создаём летопись');
  assert.equal(requests, 1, 'clock updates do not poll for the file');
  ready = true; h.setDayState({ status: 'ready' });
  h.explorer.close(); await h.explorer.open();
  assert.equal(h.explorer.state.status, 'ready');
  assert.equal(h.range.parentElement.hidden, false);
  assert.equal(h.fromDate.disabled, false);
  assert.equal(h.status.textContent, '');
  assert.equal(requests, 2);
});


test('a ready personal chart cannot hide a pending or failed lifetime file', async t => {
  const meta = deferred(), natal = { utc: '1998-08-18T14:00:00Z' };
  const h = harness({ metaPromise: meta.promise, getMomentState: () => ({ current: natal, status: 'ready' }) });
  t.after(() => h.explorer.close());
  const opening = h.explorer.restore({ opened: true, mode: 'lifetime', fromDate: '1998-08-18', toDate: '2098-08-18',
    minimumUtc: natal.utc, requestedUtc: Date.parse(natal.utc) });
  await tick();
  assert.equal(h.panel.getAttribute('aria-busy'), 'true');
  assert.equal(h.status.textContent, '');
  meta.reject(Object.assign(new Error('Данные летописи недоступны.'), { code: 'lifetime_unavailable' }));
  assert.equal(await opening, false);
  assert.equal(h.panel.dataset.status, 'error');
  assert.equal(h.panel.getAttribute('aria-busy'), 'false');
  assert.equal(h.status.textContent, 'Данные летописи недоступны.');
  h.explorer.close();
});

test('a personal range accepted before metadata preserves an unfinished date draft when the file opens', async () => {
  const meta = deferred(), natal = { utc: '1998-08-18T14:00:00Z' };
  const h = harness({ metaPromise: meta.promise, getMomentState: () => ({ current: natal, status: 'ready' }) });
  const opening = h.explorer.restore({ opened: true, mode: 'lifetime', fromDate: '1998-08-18', toDate: '2098-08-18',
    minimumUtc: natal.utc, requestedUtc: Date.parse(natal.utc) });
  await tick();
  h.type(h.fromDate, '1908');
  meta.resolve(metadata);
  assert.equal(await opening, true);
  assert.equal(h.fromDate.value, '19.08');
  assert.equal(h.explorer.state.fromDate, '1998-08-18');
  assert.equal(h.explorer.current, natal);
  assert.deepEqual(h.requests, [], 'opening a personal range reuses its original chart');
});


test('preparing previews the current transit day without overwriting a saved lifetime range', async () => {
  const h = harness({ client: { async getMeta() {
    throw Object.assign(new Error('Создаём летопись'), { code: 'lifetime_preparing' });
  } } });
  await h.explorer.restore({ opened: true, mode: 'lifetime', fromDate: '1998-08-18', toDate: '2098-08-18',
    requestedUtc: Date.parse('2000-01-01T00:00:00Z') });
  assert.equal(h.fromDate.value, '30.09.2026');
  assert.equal(h.toDate.value, '30.09.2026');
  assert.equal(h.range.min, '0');
  assert.equal(h.range.max, '1439');
  assert.equal(h.range.value, '937');
  assert.equal(h.range.disabled, true);
  assert.equal(h.hourMarks.children.length, 25);
  assert.equal(h.explorer.state.fromDate, '1998-08-18', 'the preview does not replace the pending restore target');
  h.setDay('2026-09-30T22:05:00Z');
  assert.equal(h.fromDate.value, '01.10.2026', 'the disabled date follows the transit timezone across midnight');
  assert.equal(h.toDate.value, '01.10.2026');
  assert.equal(h.range.value, '65');
});


test('the last selectable lifetime sample rounds the right edge for both grid and cached minute data', async () => {
  for (const cached of [false, true]) {
    const finalMinute = Date.parse('2000-01-02T23:59:00Z');
    const h = harness({ client: { peekMinute(utc) {
      return cached && utc >= Date.parse('2000-01-02T00:00:00Z') && utc <= finalMinute ? { ...lifetimeChartAt(metadata, point(0)), utc: new Date(utc).toISOString() } : null;
    } } });
    await open(h); await dates(h, '01012000', '02012000');
    if (!cached) await complete(h);
    h.range.dispatch('keydown', { key: 'End' }); await tick();
    if (!cached) await complete(h);
    assert.equal(h.range.value, String(Date.parse(cached ? '2000-01-02T23:59:00Z' : '2000-01-02T23:50:00Z')));
    assert.equal(h.range.getAttribute('data-edge'), 'end');
    assert.equal(h.explorer.state.maxUtc, Date.parse('2000-01-02T23:59:59.999Z'));
    h.range.dispatch('keydown', { key: 'ArrowLeft' }); await tick();
    if (!cached) await complete(h);
    assert.equal(h.range.getAttribute('data-edge'), 'none');
  }
});

test('thumb edges follow available neighbors inside a clipped lifetime window', async () => {
  const h = harness(); await open(h); await dates(h, '01012000', '02012000'); await complete(h);
  const select = async utc => { void h.explorer.scrub(Date.parse(utc)); await tick(); await complete(h); };
  await select('2000-01-01T12:00:00Z');
  h.explorer.setVisibleWindow({ minUtc: Date.parse('2000-01-01T00:05:00Z'), maxUtc: Date.parse('2000-01-01T12:05:00Z') });
  assert.equal(h.range.getAttribute('data-edge'), 'end');
  await select('2000-01-01T00:10:00Z');
  assert.equal(h.range.getAttribute('data-edge'), 'start');
  h.explorer.setVisibleWindow({ minUtc: Date.parse('2000-01-02T00:00:00Z'), maxUtc: Date.parse('2000-01-02T12:00:00Z') });
  assert.equal(h.range.getAttribute('data-edge'), 'none');
  assert.equal(h.range.getAttribute('data-cursor-visible'), 'false');
});


test('preparing dates do not acknowledge an unaccepted user range while metadata is pending', async () => {
  const meta = deferred(); let calls = 0;
  const h = harness({ client: { getMeta() { return ++calls === 1 ? meta.promise : Promise.resolve(metadata); } } });
  const opening = h.explorer.restore({ opened: true, mode: 'lifetime', fromDate: '1998-08-18', toDate: '2098-08-18',
    requestedUtc: Date.parse('2000-01-01T00:00:00Z') });
  await tick(); await dates(h, '30092026', '30092026');
  meta.reject(Object.assign(new Error('Создаём летопись'), { code: 'lifetime_preparing' }));
  await opening;
  assert.equal(h.explorer.state.fromDate, '1998-08-18');
  void h.explorer.retry(); await tick();
  assert.equal(h.explorer.state.fromDate, '2026-09-30');
  assert.equal(h.explorer.state.toDate, '2026-09-30');
  assert.equal(h.fromDate.value, '30.09.2026');
  assert.equal(h.toDate.value, '30.09.2026');
  assert.equal(h.explorer.state.mode, 'day');
});


for (const cache of ['cold', 'memory', 'missing-disk']) test(`a clipped year keeps End and rightward steps within prepared ${cache} samples`, async () => {
  const finalMinute = Date.parse('2000-12-31T23:59:00Z'), outsideMinute = Date.parse('2001-01-01T00:00:00Z');
  const cached = { ...lifetimeChartAt(metadata, moment(0)), utc: new Date(finalMinute).toISOString() };
  let diskCataloguePresent = true;
  const h = harness({ client: {
    peekMinute: value => cache === 'memory' && [finalMinute, outsideMinute].includes(value) ? { ...cached, utc: new Date(value).toISOString() } : null,
    hasMinute: value => diskCataloguePresent && cache === 'missing-disk' && [finalMinute, outsideMinute].includes(value),
    readMinute: async () => { diskCataloguePresent = false; return null; },
  } });
  await open(h); await dates(h, '18081998', '18082098'); await complete(h);
  const full = { minUtc: h.explorer.state.minUtc, maxUtc: h.explorer.state.maxUtc };
  h.explorer.setVisibleWindow({ minUtc: Date.parse('2000-01-01T00:00:00Z'), maxUtc: Date.parse('2000-12-31T23:59:59.999Z') });
  h.range.dispatch('keydown', { key: 'End' }); await tick();
  if (cache !== 'memory') await complete(h);
  const expected = cache === 'memory' ? '2000-12-31T23:59:00.000Z' : '2000-12-31T23:50:00.000Z';
  assert.equal(new Date(h.explorer.state.requestedUtc).toISOString(), expected);
  assert.equal(Date.parse(h.explorer.current.utc), Date.parse(expected));
  assert.equal(h.range.getAttribute('data-cursor-visible'), 'true');
  const requests = h.requests.length;
  h.range.dispatch('keydown', { key: 'ArrowRight' }); await tick();
  assert.equal(new Date(h.explorer.state.requestedUtc).toISOString(), expected);
  assert.equal(h.requests.length, requests, 'the next step cannot request a moment in another year');
  assert.deepEqual({ minUtc: h.explorer.state.minUtc, maxUtc: h.explorer.state.maxUtc }, full, 'year filtering never changes the full life span');
  h.explorer.close();
});

test('a clipped left edge rounds inward for both Home and pointer input', async () => {
  const h = harness(); await open(h); await dates(h, '01012000', '02012000'); await complete(h);
  h.explorer.setVisibleWindow({ minUtc: Date.parse('2000-01-01T00:04:00Z'), maxUtc: Date.parse('2000-01-01T12:05:00Z') });
  h.range.dispatch('keydown', { key: 'Home' }); await tick(); await complete(h);
  assert.equal(h.explorer.current.utc, '2000-01-01T00:10:00Z');
  assert.equal(h.range.getAttribute('data-cursor-visible'), 'true');
  h.range.value = String(Date.parse('2000-01-01T12:05:00Z'));
  h.range.dispatch('input'); await tick(); await complete(h);
  assert.equal(h.explorer.current.utc, '2000-01-01T12:00:00Z');
  assert.equal(h.range.getAttribute('data-cursor-visible'), 'true');
  h.explorer.close();
});


test('an invalid lifetime file stops metadata retries and an explicit retry retains the personal range', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let ready = false, metadataCalls = 0;
  const natal = { utc: '1998-08-18T14:00:00Z' };
  const h = harness({ getMomentState: () => ({ current: natal, status: 'ready' }), client: {
    async getMeta() { metadataCalls++; if (!ready) throw Object.assign(new Error('Данные летописи недоступны.'), { code: 'lifetime_unavailable' }); return metadata; },
  } });
  const snapshot = { opened: true, mode: 'lifetime', fromDate: '1998-08-18', toDate: '2098-08-18', minimumUtc: natal.utc, requestedUtc: Date.parse(natal.utc) };
  assert.equal(await h.explorer.restore(snapshot), false);
  assert.equal(h.explorer.state.status, 'error');
  assert.equal(h.status.textContent, 'Данные летописи недоступны.');
  assert.equal(h.explorer.state.retryCount, 0);
  t.mock.timers.tick(60_000); await tick(); h.explorer.syncTransit();
  assert.equal(metadataCalls, 1, 'a rejected file cannot be repaired by repeating its metadata request');
  ready = true; assert.equal(await h.explorer.retry(), true);
  assert.equal(h.explorer.state.status, 'ready'); assert.equal(h.status.textContent, '');
  assert.equal(h.explorer.state.fromDate, snapshot.fromDate); assert.equal(h.explorer.state.toDate, snapshot.toDate);
  assert.equal(h.explorer.current, natal); assert.equal(h.explorer.state.requestedUtc, snapshot.requestedUtc);
  h.explorer.close();
});

test('reopening the scale recovers after a rejected file has been replaced', async t => {
  let ready = false, metadataCalls = 0;
  const h = harness({ client: { async getMeta() {
    metadataCalls++; if (!ready) throw Object.assign(new Error('Данные летописи недоступны.'), { code: 'lifetime_unavailable' });
    return metadata;
  } } });
  t.after(() => h.explorer.close());
  assert.equal(await h.explorer.open(), false);
  assert.equal(h.explorer.state.status, 'error');
  h.explorer.close(); ready = true;
  assert.equal(await h.explorer.open(), true);
  assert.equal(metadataCalls, 2); assert.equal(h.explorer.state.status, 'ready'); assert.equal(h.status.textContent, '');
  assert.equal(h.explorer.current.utc, h.day.current.utc);
  h.explorer.close();
});

test('metadata rejection after a changed revision remains a file error before a new moment can load', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let metadataCalls = 0, pointCalls = 0;
  const h = harness({ client: {
    async getMeta() { if (++metadataCalls > 1) throw Object.assign(new Error('Данные летописи недоступны.'), { code: 'lifetime_unavailable' }); return metadata; },
    async getPoint() { pointCalls++; throw Object.assign(new Error('Версия изменилась.'), { code: 'unsupported_version' }); },
  } });
  await open(h);
  const selected = Date.parse('2000-01-01T00:00:00Z');
  await h.explorer.restore({ opened: true, mode: 'lifetime', fromDate: '2000-01-01', toDate: '2000-01-02', requestedUtc: selected });
  assert.equal(h.explorer.state.status, 'loading');
  t.mock.timers.tick(1000); await tick();
  assert.equal(h.explorer.state.status, 'error'); assert.equal(h.status.textContent, 'Данные летописи недоступны.');
  assert.equal(h.explorer.state.requestedUtc, selected); assert.equal(pointCalls, 1);
  t.mock.timers.tick(60_000); await tick(); assert.equal(metadataCalls, 2);
  h.explorer.close();
});

for (const failureSource of ['metadata-network', 'point', 'exact']) test(`temporary ${failureSource} errors still retry the chosen moment automatically`, async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let attempts = 0;
  const selected = Date.parse(failureSource === 'exact' ? '2000-01-01T12:37:00Z' : '2000-01-01T12:30:00Z');
  const failOnce = () => { if (++attempts === 1) throw Object.assign(new Error('Временно недоступно.'), failureSource === 'metadata-network' ? {} : { code: 'lifetime_unavailable' }); };
  const h = harness({ client: {
    async getMeta() { if (failureSource === 'metadata-network') failOnce(); return metadata; },
    async getPoint(index) { if (failureSource === 'point') failOnce(); return moment(index); },
    async getMinute(value) { failOnce(); return { ...lifetimeChartAt(metadata, moment(0)), utc: new Date(value).toISOString() }; },
  } });
  assert.equal(await h.explorer.restore({ opened: true, mode: 'lifetime', fromDate: '2000-01-01', toDate: '2000-01-02', requestedUtc: selected }), false);
  assert.equal(h.explorer.state.status, 'loading'); assert.equal(h.explorer.state.retryCount, 1);
  assert.equal(h.status.textContent, '');
  t.mock.timers.tick(1000); await tick();
  assert.equal(attempts, 2); assert.equal(h.explorer.state.status, 'ready');
  assert.equal(Date.parse(h.explorer.current.utc), selected); assert.equal(h.explorer.state.retryCount, 0);
  h.explorer.close();
});
