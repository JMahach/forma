import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { attachLifetimeControls } from '../src/views/lifetime-controls.js';
import { lifetimeChartAt } from '../src/domain/lifetime.js';
import { LIFETIME_PLANETS } from '../shared/lifetime-format.js';
import { createLocalDayTimeline, timelineIndexAt } from '../src/domain/day-timeline.js';
import { returnAge } from '../src/views/returns-clock.js';
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
  const elements = Object.fromEntries(['toggle', 'panel', 'range', 'fromDate', 'toDate', 'fromCalendar', 'toCalendar', 'marker', 'date', 'time', 'status', 'retryButton'].map(name => [name, document.createElement(name.endsWith('Date') ? 'input' : 'div')]));
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

test('only accepted timeline gestures interrupt restoration while opening and retry retain it', async () => {
  let interruptions = 0;
  const h = harness({ onMomentInput: () => { interruptions++; } }); await open(h);
  assert.equal(interruptions, 0);
  h.range.value = '100'; h.range.dispatch('input');
  assert.deepEqual(h.dayScrubs, [100]); assert.equal(interruptions, 1);
  h.marker.dispatch('click', { detail: 0 });
  assert.deepEqual(h.dayReturns, [[]]); assert.equal(interruptions, 2);
  h.setDayState({ status: 'error', error: 'Offline' }); h.retryButton.dispatch('click');
  assert.equal(h.dayReturns.length, 2); assert.equal(interruptions, 2, 'Retry retains the same target');
  h.setDayState({ status: 'ready', error: '' });
  h.fromCalendar.dispatch('click'); const calendar = h.document.body.children[0];
  calendar.all(node => node.tagName === 'button' && node.textContent === '2026')[0].dispatch('click');
  assert.equal(interruptions, 2, 'browsing the calendar has not accepted a range');
  h.document.dispatch('pointerdown', { target: h.document.body });
  assert.equal(interruptions, 3, 'committing a calendar range is a moment command');
  assert.equal(h.explorer.state.fromDate, '2026-01-01');
  await tick(); await complete(h);
});

test('Years view updates its panel without overwriting the navigation-owned toolbar action', async () => {
  const h = harness();
  h.toggle.title = 'Возвраты';
  h.toggle.setAttribute('aria-expanded', 'true'); h.toggle.setAttribute('aria-pressed', 'true');
  await h.explorer.open(); h.explorer.close();
  assert.equal(h.panel.hidden, true);
  assert.equal(h.toggle.title, 'Возвраты');
  assert.equal(h.toggle.getAttribute('aria-expanded'), 'true');
  assert.equal(h.toggle.getAttribute('aria-pressed'), 'true');
});

test('opening owns a visible day slider and delegates exact minute/Now actions with no archive point request', async () => {
  const h = harness(); assert.equal(h.panel.hidden, true); await open(h);
  assert.equal(h.panel.hidden, false); assert.equal(h.panel.dataset.mode, 'day');
  assert.equal(h.range.disabled, false); assert.equal(h.range.hidden, false); assert.equal(h.range.parentElement.hidden, false);
  assert.deepEqual([h.range.min, h.range.max, h.range.value, h.range.step], ['0', '1439', '937', '1']);
  assert.equal(h.fromDate.value, '30.09.2026'); assert.equal(h.toDate.value, '30.09.2026');
  assert.equal(h.date.textContent, '30.09.2026'); assert.equal(h.time.textContent, '15:37 · UTC+3');
  assert.equal(h.time.dateTime, '2026-09-30T12:37:00.000Z'); assert.equal(h.time.title, 'Europe/Moscow');
  assert.equal(h.marker.hidden, false); assert.equal(h.requests.length, 0);
  assert.equal(h.marker.getAttribute('aria-pressed'), 'true');
  h.range.value = '100'; h.range.dispatch('input'); assert.deepEqual(h.dayScrubs, [100]); assert.equal(h.requests.length, 0);
  h.marker.dispatch('click', { detail: 0 }); assert.deepEqual(h.dayReturns, [[]]); assert.deepEqual(h.dayScrubs, [100]);
  h.setDay('2026-09-30T12:38:00Z'); assert.equal(h.time.textContent, '15:38 · UTC+3');
  assert.deepEqual(h.marks.map(mark => mark.textContent), ['', '']);
});

test('one transit update synchronizes the borrowed day and notifies the controls once', async () => {
  const h = harness(); await open(h);
  const next = { ...h.day.current, utc: '2026-09-30T12:38:00Z' };
  h.notifications.length = 0;
  h.setDayState({ current: next, index: 938, referenceIndex: 938 });
  assert.equal(h.explorer.current.utc, next.utc);
  assert.equal(h.time.dateTime, '2026-09-30T12:38:00.000Z');
  assert.equal(h.notifications.length, 1);
});
test('archive range owns its sampled clock and current marker; today-to-today restores the exact day', async () => {
  const h = harness(); await open(h); await dates(h, '29092026', '01102026'); await complete(h);
  assert.equal(h.range.disabled, false); assert.equal(h.range.hidden, false); assert.equal(h.range.parentElement.hidden, false);
  assert.equal(h.time.textContent, '12:30 · UTC'); assert.equal(h.marker.hidden, false);
  assert.equal(h.marker.getAttribute('aria-pressed'), 'false');
  h.setNow('2026-09-30T12:48:00Z'); assert.equal(h.time.textContent, '12:30 · UTC'); assert.equal(h.marker.getAttribute('aria-pressed'), 'false');
  h.marker.dispatch('click', { detail: 0 }); await tick(); await complete(h); assert.equal(h.time.textContent, '12:50 · UTC');
  const requests = h.requests.length; await dates(h, '30092026', '30092026');
  assert.equal(h.explorer.state.mode, 'day'); assert.equal(h.time.textContent, '15:37 · UTC+3');
  assert.equal(h.range.hidden, false); assert.equal(h.marker.hidden, false); assert.equal(h.requests.length, requests);
  assert.deepEqual([h.range.min, h.range.max, h.range.value], ['0', '1439', '937']);
  assert.deepEqual(h.dayScrubs, []); assert.deepEqual(h.dayReturns, [], 'archive reference never invokes day Now');
  h.range.value = '120'; h.range.dispatch('input'); assert.deepEqual(h.dayScrubs, [120]);
});

test('personal live archive clock borrows each exact day minute without requesting archive points', async () => {
  let liveState = null, nowCalls = 0;
  const h = harness({ getMomentState: () => liveState,
    onArchiveNow: () => { nowCalls++; return true; } });
  await open(h); await dates(h, '29092026', '01102026'); await complete(h);
  assert.equal(h.marker.hidden, false, 'the current-time reference remains on the rail');
  const requests = h.requests.length;
  liveState = h.day; h.explorer.syncTransit();
  assert.equal(h.time.textContent, '12:37 · UTC');
  assert.match(h.range.getAttribute('aria-valuetext'), /12:37/);
  assert.equal(h.marker.getAttribute('aria-pressed'), 'true');
  liveState = { ...liveState, current: { ...liveState.current, utc: '2026-09-30T12:38:00Z' } };
  h.explorer.syncTransit();
  assert.equal(h.time.textContent, '12:38 · UTC');
  assert.equal(h.requests.length, requests);
  h.marker.dispatch('click', { detail: 0 });
  assert.equal(nowCalls, 1);
  assert.equal(h.requests.length, requests, 'live Now is not an archive scrub');
  liveState = { ...liveState, status: 'error', error: 'Текущий день недоступен' }; h.explorer.syncTransit();
  assert.equal(h.status.textContent, 'Текущий день недоступен');
  h.retryButton.dispatch('click'); assert.equal(nowCalls, 2);
  assert.equal(h.requests.length, requests, 'retry stays with the failed live owner');
  liveState = null; h.explorer.syncTransit();
  assert.equal(h.time.textContent, '12:30 · UTC', 'leaving live ownership repaints even when the archive index does not change');
  h.range.value = String(h.explorer.state.requestedUtc + 600000); h.range.dispatch('input');
  await tick(); await complete(h);
  assert.equal(h.time.textContent, '12:40 · UTC', 'manual scrubbing returns ownership to the archive');
});

test('an exact return aligns the archive and its precise clock without fetching a rounded point', async () => {
  let owner = null;
  const h = harness({ getMomentState: () => owner, beforeScrub: () => { owner = null; } });
  await open(h);
  const utc = '2026-09-30T12:37:29.432Z';
  owner = { current: { ...h.day.current, utc }, status: 'ready', live: false };
  const index = Math.round((Date.parse(utc) - Date.parse(metadata.startUtc)) / 600000);
  const restoring = h.explorer.restore({ opened: true, mode: 'archive', fromDate: '2026-09-29', toDate: '2026-10-01', index });
  await tick(); assert.equal(h.requests.length, 0); assert.equal(await restoring, true);
  assert.equal(h.range.value, String(Date.parse(utc))); assert.equal(h.time.dateTime, utc);
  assert.equal(h.time.textContent, '12:37:29.432 · UTC');
  assert.match(h.range.getAttribute('aria-valuetext'), /12:37:29\.432/);
  assert.doesNotMatch(h.range.getAttribute('aria-valuetext'), /не показано|загружается/);
  assert.equal(h.marker.getAttribute('aria-pressed'), 'false');
  h.range.dispatch('input'); await tick();
  assert.equal(h.requests.length, 1, 'manual selection of the aligned slot still chooses its grid sample');
  await complete(h);
  assert.equal(h.time.textContent, '12:40 · UTC');
  assert.equal(h.time.dateTime, point(index).utc);
});

test('a borrowed live minute has the same exact UTC position in the control and archive state', async () => {
  let owner = null;
  const h = harness({ getMomentState: () => owner });
  await open(h); owner = h.day;
  const index = Math.round((Date.parse(owner.current.utc) - Date.parse(metadata.startUtc)) / 600000);
  await h.explorer.restore({ opened: true, mode: 'archive', fromDate: '2026-09-29', toDate: '2026-10-01', index });
  assert.equal(h.time.textContent, '12:37 · UTC');
  assert.equal(h.explorer.state.requestedUtc, Date.parse(owner.current.utc)); assert.equal(Number(h.range.value), h.explorer.state.requestedUtc);
  owner = { ...owner, current: { ...owner.current, utc: '2026-09-30T12:38:00Z' } };
  h.explorer.alignMoment(owner.current); h.explorer.syncTransit();
  assert.equal(h.time.textContent, '12:38 · UTC'); assert.equal(Number(h.range.value), h.explorer.state.requestedUtc);
  assert.equal(h.requests.length, 0);
});

test('Years day range follows real short/long local days and readiness/reference updates without a new chart', async () => {
  const h = harness(); await open(h);
  for (const [utc, minutes] of [['2026-03-08T16:00:00Z', 1380], ['2026-11-01T17:00:00Z', 1500]]) {
    h.setDay(utc, 'America/New_York');
    h.setDayState({ referenceIndex: minutes - 1, index: 90, live: false });
    assert.equal(h.range.max, String(minutes - 1)); assert.equal(h.range.value, '90');
    assert.equal(h.marker.style.left, '100%'); assert.equal(h.marker.getAttribute('aria-pressed'), 'false');
    const chart = h.day.current, shown = h.time.textContent;
    h.setDayState({ status: 'loading' });
    assert.equal(h.day.current, chart); assert.equal(h.range.disabled, true); assert.equal(h.range.hidden, false);
    assert.equal(h.range.parentElement.hidden, false); assert.equal(h.marker.hidden, true);
    assert.equal(h.panel.getAttribute('aria-busy'), 'true'); assert.equal(h.status.textContent, 'Загружаем день…');
    h.range.dispatch('input'); h.marker.dispatch('click', { detail: 0 });
    assert.deepEqual(h.dayScrubs, []); assert.deepEqual(h.dayReturns, []);
    h.setDayState({ status: 'error', error: 'Недоступен текущий день' });
    assert.equal(h.range.disabled, true); assert.equal(h.retryButton.hidden, false);
    assert.equal(h.panel.dataset.status, 'error'); assert.equal(h.status.textContent, 'Недоступен текущий день');
    h.retryButton.dispatch('click'); assert.deepEqual(h.dayReturns.splice(0), [[]]); assert.equal(h.requests.length, 0);
    h.setDayState({ status: 'ready', error: '', referenceIndex: 300 });
    assert.equal(h.day.current, chart); assert.equal(h.time.textContent, shown);
    assert.equal(h.range.disabled, false); assert.equal(h.marker.hidden, false); assert.equal(h.retryButton.hidden, true);
    assert.equal(h.marker.style.left, `${300 / (minutes - 1) * 100}%`);
    assert.equal(h.range.getAttribute('aria-valuetext').includes('01:30'), true);
  }
});

test('the ready day slider works before archive metadata arrives and closed controls never delegate input', async () => {
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
test('day date follows local midnight rather than the archive UTC date', async () => {
  const h = harness(); await open(h); h.setDay('2026-09-30T23:57:00Z', 'Asia/Tokyo');
  assert.equal(h.date.textContent, '01.10.2026'); assert.equal(h.time.textContent, '08:57 · UTC+9');
  assert.equal(h.fromDate.value, '01.10.2026'); assert.equal(h.toDate.value, '01.10.2026'); assert.equal(h.requests.length, 0);
});

test('reused day labels retain drafts and refresh readiness, reference and resized slider input', async () => {
  const h = harness(); await open(h);
  const writes = [];
  for (const [name, property] of [['date', 'textContent'], ['time', 'textContent'], ['status', 'textContent'], ['fromDate', 'value'], ['toDate', 'value']]) {
    let value = h[name][property];
    Object.defineProperty(h[name], property, { get: () => value, set(next) { value = next; writes.push(name); } });
  }
  const notices = h.notifications.length;
  h.explorer.syncTransit(); h.setDayState({ referenceIndex: 940, live: false });
  assert.deepEqual(writes, []);
  assert.equal(h.notifications.length, notices + 2, 'text reuse cannot suppress owner notifications');
  assert.equal(h.marker.style.left, `${940 / 1439 * 100}%`);
  h.setDayState({ status: 'loading' });
  assert.deepEqual(writes.splice(0), ['status']); assert.equal(h.range.disabled, true);
  h.setDayState({ status: 'error', error: 'Нет сети' });
  assert.deepEqual(writes.splice(0), ['status']); assert.equal(h.retryButton.hidden, false);
  h.type(h.fromDate, '1508'); writes.length = 0;
  h.setDayState({ status: 'ready', error: '' }); h.explorer.syncTransit();
  assert.equal(h.fromDate.value, '15.08');
  assert.ok(!writes.includes('fromDate') && !writes.includes('toDate'));
  assert.equal(h.range.disabled, false); assert.equal(h.retryButton.hidden, true);
  for (const width of [400, 800]) {
    h.explorer.syncTransit();
    h.range.getBoundingClientRect = () => ({ left: 0, width, height: 56 });
    const event = { pointerType: 'touch', pointerId: 1, button: 0, clientX: 100, clientY: 20 };
    h.range.dispatch('pointerdown', event); h.range.dispatch('pointerup', event);
  }
  assert.deepEqual(h.dayScrubs, [315, 148], 'each drag still reads the current viewport geometry');
  h.setDay(h.day.current.utc, 'Asia/Tokyo');
  assert.equal(h.time.textContent, '21:37 · UTC+9', 'same UTC in another explicit zone updates immediately');
  assert.equal(h.fromDate.value, '15.08');
});
test('first Tab retains the typed start; full right date commits the inclusive pair', async () => {
  const h = harness(); await open(h); h.type(h.fromDate, '11081998'); h.fromDate.dispatch('change');
  let prevented = false; h.fromDate.dispatch('keydown', { key: 'Tab', preventDefault() { prevented = true; } });
  assert.equal(prevented, true); assert.equal(h.document.activeElement, h.toDate);
  assert.deepEqual([h.toDate.selectionStart, h.toDate.selectionEnd], [0, 10]);
  let reversePrevented = false; h.fromDate.dispatch('keydown', { key: 'Tab', shiftKey: true, preventDefault() { reversePrevented = true; } });
  assert.equal(reversePrevented, false, 'Shift+Tab preserves native access to the calendar button');
  h.setDay('2026-09-30T12:38:00Z'); assert.equal(h.fromDate.value, '11.08.1998'); assert.equal(h.requests.length, 0);
  h.type(h.toDate, '12081998'); await tick();
  assert.equal(h.explorer.state.fromDate, '1998-08-11'); assert.equal(h.explorer.state.toDate, '1998-08-12');
  assert.equal(Number(h.range.max) - Number(h.range.min) + 1, 172800000); assert.equal(h.time.textContent, '12:38 · UTC');
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
test('invalid, reversed, unsupported and incomplete drafts preserve the displayed point', async () => {
  for (const [from, to, reason] of [['11081998', '31021998', /такого дня/], ['13081998', '12081998', /не позже/], ['01011800', '02011800', /1801/]]) {
    const h = harness(); await open(h); const current = h.explorer.current; await dates(h, from, to);
    assert.equal(h.requests.length, 0); assert.equal(h.explorer.current, current); assert.match(h.status.textContent, reason);
  }
  const h = harness(); await open(h); h.type(h.toDate, '1208'); h.toDate.dispatch('change');
  assert.match(h.status.textContent, /полностью/); assert.equal(h.toDate.getAttribute('aria-invalid'), 'true');
  h.type(h.toDate, '120'); assert.equal(h.status.textContent, '');
});
test('pending point completion and clock refresh preserve unfinished drafts in both inputs', async () => {
  const h = harness(); await open(h); await dates(h);
  h.type(h.fromDate, '15081998'); h.type(h.toDate, '1708'); h.toggle.focus(); await complete(h);
  h.setNow('2026-09-30T12:48:00Z'); assert.equal(h.fromDate.value, '15.08.1998'); assert.equal(h.toDate.value, '17.08');
});
test('a ninth pasted digit is retained and rejected instead of silently committing eight digits', async () => {
  const h = harness(); await open(h); await dates(h, '110819981', '12081998');
  assert.equal(h.fromDate.value, '110819981'); assert.match(h.status.textContent, /восемь цифр/);
  h.toDate.dispatch('keydown', { key: 'Enter' }); assert.equal(h.requests.length, 0);
  h.type(h.fromDate, '11081998'); h.toDate.dispatch('change'); await tick(); assert.equal(h.requests.length, 1); await complete(h);
});
test('drafts entered while metadata is pending survive and apply when it becomes available', async () => {
  const meta = deferred(), h = harness({ metaPromise: meta.promise }); const opening = h.explorer.open();
  await dates(h); assert.match(h.status.textContent, /Загружаем диапазон/); assert.equal(h.fromCalendar.disabled, true);
  meta.resolve(metadata); await tick(); assert.equal(h.explorer.state.fromDate, '1998-08-11');
  await complete(h, 0); if (h.requests.length > 1) await complete(h); await opening;
  assert.equal(h.status.textContent, ''); assert.equal(h.fromDate.value, '11.08.1998');
  const pending = deferred(), changed = harness({ metaPromise: pending.promise }); const other = changed.explorer.open();
  await dates(changed); changed.type(changed.fromDate, '1508'); pending.resolve(metadata); await other; await tick(); assert.equal(changed.requests.length, 0);
  assert.equal(changed.fromDate.value, '15.08'); assert.equal(changed.explorer.state.fromDate, '2026-09-30');
});
test('Enter commits a complete pair; unchanged change event adds no request', async () => {
  const h = harness(); await open(h); h.type(h.fromDate, '29092026');
  h.fromDate.dispatch('keydown', { key: 'Enter' }); await tick(); assert.equal(h.explorer.state.fromDate, '2026-09-29');
  const count = h.requests.length; h.toDate.dispatch('change'); await tick(); assert.equal(h.requests.length, count);
});
test('scrub loading/error label stays on the displayed point and retry keeps the chosen range', async () => {
  const h = harness(); await open(h); await dates(h); await complete(h);
  const before = h.time.dateTime, next = Number(h.range.min) + 600000;
  h.range.value = String(next); h.range.dispatch('input'); await tick(); assert.equal(h.time.dateTime, before);
  h.requests.at(-1).reject(new Error('Проверка повторной загрузки')); await tick(); assert.equal(h.time.dateTime, before); assert.equal(h.retryButton.hidden, false);
  h.retryButton.dispatch('click'); await tick(); await complete(h); assert.equal(h.retryButton.hidden, true);
  assert.equal(h.fromDate.value, '11.08.1998'); assert.equal(h.toDate.value, '12.08.1998');
});

test('quick archive requests keep the shown clock and never flash a loading message', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = harness(); await open(h); await dates(h); await complete(h);
  const shown = [h.date.textContent, h.time.textContent, h.time.dateTime];
  const next = Number(h.range.min) + 600000;
  h.range.value = String(next); h.range.dispatch('input'); await tick();
  assert.equal(h.requests.at(-1).index, (next - Date.parse(metadata.startUtc)) / 600000, 'the request starts without waiting for the label');
  assert.equal(h.range.value, String(next)); assert.equal(h.range.disabled, false);
  assert.equal(h.panel.getAttribute('aria-busy'), 'true');
  assert.match(h.range.getAttribute('aria-valuetext'), /загружается/);
  assert.deepEqual([h.date.textContent, h.time.textContent, h.time.dateTime], shown);
  t.mock.timers.tick(399); assert.equal(h.status.textContent, '');
  await complete(h);
  assert.equal(h.explorer.state.status, 'ready'); assert.equal(h.status.textContent, '');
  assert.notEqual(h.time.dateTime, shown[2]);
  t.mock.timers.tick(1000); assert.equal(h.status.textContent, '', 'a completed request cancels its delayed label');
  h.explorer.scrub(next + 600000); await tick();
  t.mock.timers.tick(399); assert.equal(h.status.textContent, '', 'a new request receives its own delay');
  t.mock.timers.tick(1); assert.equal(h.status.textContent, 'Загружаем момент…');
  await complete(h); assert.equal(h.status.textContent, '');
});

test('continuous scrubbing has one 400 ms loading episode across updates and partial responses', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = harness(); await open(h); await dates(h);
  const first = h.requests[0], notices = h.notifications.length;
  t.mock.timers.tick(200);
  h.explorer.scrub(Date.parse(point(first.index - 1).utc)); h.explorer.scrub(Date.parse(point(first.index - 2).utc));
  assert.equal(h.requests.length, 1, 'the existing one-flight request policy is unchanged');
  assert.equal(h.range.value, String(Date.parse(point(first.index - 2).utc)));
  t.mock.timers.tick(199); assert.equal(h.status.textContent, '');
  const beforeTimerNotices = h.notifications.length;
  t.mock.timers.tick(1); assert.equal(h.status.textContent, 'Загружаем момент…');
  assert.ok(h.notifications.length > notices, 'state updates continue during the delay');
  assert.equal(h.notifications.length, beforeTimerNotices, 'the timer only changes the message');
  t.mock.timers.tick(1000); assert.equal(h.notifications.length, beforeTimerNotices, 'the label timer never redraws or notifies the owner');
  await complete(h, 0);
  assert.equal(h.requests.length, 2); assert.equal(h.status.textContent, 'Загружаем момент…');
  assert.equal(h.explorer.state.status, 'loading', 'an intermediate displayed point does not restart the episode');
  await complete(h, 1); assert.equal(h.status.textContent, '');
});

test('errors, close and returning to today cancel delayed labels, including stale callbacks', async t => {
  const timers = [];
  t.mock.method(globalThis, 'setTimeout', callback => { const timer = { callback }; timers.push(timer); return timer; });
  t.mock.method(globalThis, 'clearTimeout', timer => { timer.cancelled = true; });
  const h = harness(); await open(h); await dates(h);
  const firstTimer = timers.at(-1);
  h.requests.at(-1).reject(new Error('Нет соединения')); await tick();
  assert.equal(firstTimer.cancelled, true); assert.equal(h.status.textContent, 'Нет соединения');
  firstTimer.callback(); assert.equal(h.status.textContent, 'Нет соединения');
  h.retryButton.dispatch('click'); await tick(); const retryTimer = timers.at(-1);
  assert.notEqual(retryTimer, firstTimer); assert.equal(h.status.textContent, '');
  firstTimer.callback(); assert.equal(h.status.textContent, '', 'an old episode cannot reveal the retry label early');
  h.explorer.close(); assert.equal(retryTimer.cancelled, true); assert.equal(h.panel.hidden, true);
  retryTimer.callback(); assert.equal(h.status.textContent, '');
  await open(h); await dates(h); const archiveTimer = timers.at(-1);
  await dates(h, '30092026', '30092026');
  assert.equal(h.explorer.state.mode, 'day'); assert.equal(archiveTimer.cancelled, true);
  archiveTimer.callback(); assert.equal(h.status.textContent, '');
  assert.equal(h.time.textContent, '15:37 · UTC+3');
});

test('a delayed loading label cannot overwrite an unfinished date error', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = harness(); await open(h); await dates(h);
  h.type(h.toDate, '31021998'); const error = h.status.textContent;
  assert.match(error, /такого дня/);
  t.mock.timers.tick(400); assert.equal(h.status.textContent, error);
  await complete(h); assert.equal(h.status.textContent, error);
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
test('Years owns one visible range in either mode without overlapping the ordinary transit panel', async () => {
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
  const dayToggle = html.match(/<button[^>]*id="chartDayToggle"[^>]*>[\s\S]*?<\/button>/)?.[0];
  assert.match(dayToggle, /aria-label="Шкала дня"/);
  assert.doesNotMatch(dayToggle, /<span/);
  assert.doesNotMatch(html, /id="lifetimeClose"/);
  assert.doesNotMatch(css, /#lifetimeClose/);
  assert.match(html, /class="day-reference" id="lifetimeReference"/);
  assert.doesNotMatch(css, /\.lifetime-controls\[data-mode='day'\]/);
  assert.doesNotMatch(css, /#lifetimeControls\[data-mode='day'\]/);
  assert.match(css, /\.lifetime-controls::before\s*\{\s*bottom: 0;/);
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
  click('2027'); h.document.dispatch('pointerdown', { target: h.date });
  assert.equal(h.fromDate.value, '01.01.2027'); assert.equal(h.toDate.value, '');
  await tick(); await complete(h);
  assert.equal(h.status.textContent, ''); assert.equal(h.toDate.getAttribute('aria-invalid'), 'false');
  assert.equal(h.explorer.state.openEnded, true); assert.equal(h.range.disabled, false);
});

test('equal dates and incomplete, impossible or outside-archive start drafts never clear the end', async () => {
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

test('touch scrubbing calls beforeScrub before day/archive actions without a native input event', async () => {
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
  assert.equal(nativeInputs, 0); assert.equal(actions.length, 2); assert.equal(actions[1].mode, 'archive');
  assert.equal(actions[1].index, initial); assert.notEqual(h.explorer.state.requestedUtc, initial);
  const userActions = actions.length; h.explorer.scrub(h.explorer.state.requestedUtc + 600000);
  assert.equal(actions.length, userActions, 'programmatic marker alignment does not activate manual preview');
});
test('reference actions invoke beforeScrub before day Now and archive return to the current moment', async () => {
  const actions = []; let h;
  h = harness({ beforeScrub: () => actions.push({ mode: h.explorer.state.mode, index: h.explorer.state.requestedUtc, returns: h.dayReturns.length }) });
  await open(h); h.marker.dispatch('click', { detail: 0 });
  assert.deepEqual(actions, [{ mode: 'day', index: h.explorer.state.requestedUtc, returns: 0 }]); assert.equal(h.dayReturns.length, 1);
  await dates(h, '29092026', '01102026'); await complete(h);
  h.explorer.scrub(h.explorer.state.minUtc); await tick(); await complete(h); const oldIndex = h.explorer.state.requestedUtc;
  h.marker.dispatch('click', { detail: 0 });
  assert.equal(actions.length, 2); assert.equal(actions[1].mode, 'archive'); assert.equal(actions[1].index, oldIndex);
  assert.equal(h.explorer.state.requestedUtc, Date.parse('2026-09-30T12:40:00Z'));
});

test('an exact birth endpoint can own a scrub while the Now marker still supplies its actual target UTC', async () => {
  const targets = [];
  const h = harness({ beforeScrub: value => { targets.push(value); return false; } });
  await open(h); await dates(h, '29092026', '01102026'); await complete(h);
  const index = h.explorer.state.requestedUtc, requests = h.requests.length;
  h.range.value = h.range.min; h.range.dispatch('input');
  assert.equal(targets[0], h.explorer.state.minUtc);
  assert.equal(h.explorer.state.requestedUtc, index, 'the exact endpoint owner prevents an extra archive sample');
  assert.equal(h.requests.length, requests);
  h.setNow('2026-09-30T12:48:00Z');
  h.marker.dispatch('click', { detail: 0 });
  assert.equal(targets[1], h.explorer.state.referenceUtc, 'Now must not reuse the thumb position at birth');
  assert.equal(h.requests.length, requests);
});


test('loading feedback follows the live owner even when the archive is ready', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let live = null;
  const h = harness({ getMomentState: () => live });
  await open(h); await dates(h); await complete(h);
  live = { ...h.day, status: 'loading' }; h.explorer.syncTransit();
  assert.equal(h.explorer.state.status, 'ready');
  t.mock.timers.tick(399); assert.equal(h.status.textContent, '');
  t.mock.timers.tick(1); assert.equal(h.status.textContent, 'Загружаем момент…');
  live = { ...live, status: 'ready' }; h.explorer.syncTransit();
  assert.equal(h.status.textContent, '');
});

test('endpoint labels have one owner for personal and standalone ranges and unchanged refreshes make no text writes', async t => {
  for (const personal of [false, true]) await t.test(personal ? 'personal life' : 'standalone archive', async () => {
    let borrowed = null;
    const natal = { utc: '1998-08-11T12:34:56Z', timezone: 'UTC' };
    const h = harness({ getMomentState: () => borrowed,
      formatEndpoints: state => personal ? ['Рождение', `${returnAge(`${state.toDate}T23:59:59Z`, natal)} лет`] : null });
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


test('archive UTC keeps cached minute keyboard steps, exact boundaries and the birth owner reachable', async () => {
  const targets = [], minimumUtc = Date.parse('1998-08-11T12:34:56Z');
  let ready = null;
  const h = harness({ client: { peekMinute: utc => ready && Math.floor(utc / 60000) * 60000 === Date.parse(ready.utc) ? ready : null },
    beforeScrub: utc => { targets.push(utc); return utc !== minimumUtc; } });
  await open(h);
  const restoring = h.explorer.restore({ opened: true, mode: 'archive', fromDate: '1998-08-11', toDate: '1998-08-12',
    minimumUtc: '1998-08-11T12:34:56Z', requestedUtc: Date.parse('1998-08-12T12:30:00Z') });
  await tick(); await complete(h); await restoring;
  assert.equal(h.range.min, String(minimumUtc)); assert.equal(h.range.max, String(Date.parse('1998-08-12T23:59:59.999Z')));
  assert.equal(h.range.step, 'any');
  const utc = Date.parse('1998-08-12T12:31:00Z');
  ready = { ...h.day.current, utc: new Date(utc).toISOString() };
  h.range.value = String(utc); h.range.dispatch('input');
  assert.equal(h.range.value, String(utc)); assert.equal(h.time.textContent, '12:31 · UTC');
  const requests = h.requests.length;
  ready = { ...ready, utc: '1998-08-12T12:32:00Z' };
  h.range.dispatch('keydown', { key: 'ArrowRight' });
  assert.equal(h.range.value, String(utc + 60000)); assert.equal(h.requests.length, requests);
  assert.equal(targets.at(-1), utc + 60000);
  h.range.dispatch('keydown', { key: 'Home' });
  assert.equal(targets.at(-1), minimumUtc, 'Home is offered to the exact birth owner before archive snapping');
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
