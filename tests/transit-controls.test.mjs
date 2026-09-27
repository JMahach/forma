import test from 'node:test';
import assert from 'node:assert/strict';
import { attachTransitControls } from '../src/views/transit-controls.js';
import { createLocalDayTimeline } from '../src/domain/day-timeline.js';

function element() {
  const attributes = new Map(), listeners = new Map();
  return {
    hidden: false, disabled: false, dataset: {}, style: {}, value: '', textContent: '', title: '', dateTime: '',
    setAttribute(name, value) { attributes.set(name, String(value)); },
    getAttribute(name) { return attributes.get(name) ?? null; },
    addEventListener(type, callback) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(callback);
    },
    dispatch(type) { for (const callback of listeners.get(type) || []) callback({ target: this }); },
  };
}

function harness(withMarker = true) {
  const elements = Object.fromEntries(['panel', 'range', 'date', 'time', 'status', 'nowButton', ...(withMarker ? ['marker'] : [])].map(name => [name, element()]));
  const scrubCalls = [], nowCalls = [];
  const controls = attachTransitControls({
    ...elements,
    onScrub: (...args) => scrubCalls.push(args),
    onNow: (...args) => nowCalls.push(args),
  });
  return { ...elements, ...controls, scrubCalls, nowCalls };
}

const timeline = (date = '2026-09-24', zone = 'Asia/Kathmandu') => createLocalDayTimeline(Date.parse(`${date}T12:00:00Z`), zone);
const state = (overrides = {}) => ({ wanted: true, live: true, status: 'ready', timeline: timeline(), index: 0, referenceIndex: 0, ...overrides });

test('controls are visible only when transit is wanted, independently of readiness and live mode', () => {
  const h = harness();
  for (const status of ['idle', 'loading', 'ready', 'error']) {
    for (const wanted of [false, true]) {
      for (const live of [false, true]) {
        h.update(state({ status, wanted, live }));
        assert.equal(h.panel.hidden, !wanted);
        assert.equal(h.panel.dataset.live, String(live));
        assert.equal(h.panel.dataset.status, status);
        assert.equal(h.nowButton.getAttribute('aria-pressed'), String(live));
      }
    }
  }
  assert.deepEqual(h.scrubCalls, [], 'rendering state never requests a minute change');
  assert.deepEqual(h.nowCalls, [], 'rendering state never requests a live refresh');
});

test('range covers every actual minute of ordinary, short and long local days', () => {
  const h = harness();
  for (const [date, zone, minutes] of [
    ['2026-09-24', 'Asia/Kathmandu', 1440],
    ['2026-03-08', 'America/New_York', 1380],
    ['2026-11-01', 'America/New_York', 1500],
    ['2026-10-04', 'Australia/Lord_Howe', 1410],
    ['2026-04-05', 'Australia/Lord_Howe', 1470],
  ]) {
    const day = timeline(date, zone);
    h.update(state({ timeline: day, index: minutes - 1 }));
    assert.equal(h.range.min, '0', `${zone} ${date}`);
    assert.equal(h.range.max, String(minutes - 1), `${zone} ${date}`);
    assert.equal(h.range.step, '1');
    assert.equal(h.range.value, String(minutes - 1));
    assert.equal(h.range.disabled, false);
    assert.match(h.time.textContent, /^23:59 · UTC/);
    assert.equal(Date.parse(h.time.dateTime), day.endUtc - 60_000);
    assert.equal(h.time.title, zone);
  }
});

test('input forwards the exact numeric minute and Now delegates only its own callback', () => {
  const h = harness();
  h.update(state({ timeline: timeline('2026-11-01', 'America/New_York'), index: 90, live: false }));
  for (const minute of [0, 90, 119, 120, 150, 720, 1499]) {
    h.range.value = String(minute);
    h.range.dispatch('input');
  }
  assert.deepEqual(h.scrubCalls, [[0], [90], [119], [120], [150], [720], [1499]]);
  assert.deepEqual(h.nowCalls, []);
  h.nowButton.dispatch('click');
  assert.deepEqual(h.nowCalls, [[]], 'Now passes no event or minute to the live controller');
  assert.equal(h.scrubCalls.length, 7, 'Now does not initiate a second scrub');
  assert.equal(h.range.value, '1499', 'the owner supplies the refreshed current minute');
  assert.equal(h.nowButton.getAttribute('aria-pressed'), 'false', 'live mode changes when the owner publishes state');
});

test('the reference button delegates to live Now without scrubbing a rounded reference minute', () => {
  const h = harness();
  h.update(state({ index: 10, referenceIndex: 754, live: false }));
  h.marker.dispatch('click');
  assert.deepEqual(h.nowCalls, [[]]);
  assert.deepEqual(h.scrubCalls, []);
  assert.equal(h.range.value, '10', 'the live controller remains the owner of the selected time');
  assert.equal(h.marker.getAttribute('aria-label'), 'Вернуться к текущему времени');
  h.update(state({ status: 'loading' })); h.marker.dispatch('click');
  assert.deepEqual(h.nowCalls, [[]], 'an unavailable reference cannot start a return');
});

test('repeated autumn clock times have distinct UTC offsets in visible and accessible labels', () => {
  const h = harness();
  const day = timeline('2026-11-01', 'America/New_York');
  h.update(state({ timeline: day, index: 90, live: false }));
  assert.equal(h.date.textContent, '1 ноября');
  assert.equal(h.time.textContent, '01:30 · UTC-4');
  assert.equal(h.time.dateTime, '2026-11-01T05:30:00.000Z');
  assert.equal(h.range.getAttribute('aria-valuetext'), '1 ноября, 01:30, UTC-4');
  h.update(state({ timeline: day, index: 150, live: false }));
  assert.equal(h.date.textContent, '1 ноября');
  assert.equal(h.time.textContent, '01:30 · UTC-5');
  assert.equal(h.time.dateTime, '2026-11-01T06:30:00.000Z');
  assert.equal(h.range.getAttribute('aria-valuetext'), '1 ноября, 01:30, UTC-5');
});

test('spring minute labels skip nonexistent clock times and include fractional zone offsets', () => {
  const h = harness();
  const day = timeline('2026-03-08', 'America/New_York');
  h.update(state({ timeline: day, index: 119 }));
  assert.equal(h.time.textContent, '01:59 · UTC-5');
  h.update(state({ timeline: day, index: 120 }));
  assert.equal(h.time.textContent, '03:00 · UTC-4');
  assert.equal(h.range.getAttribute('aria-valuetext'), '8 марта, 03:00, UTC-4');
  h.update(state({ index: 0 }));
  assert.equal(h.time.textContent, '00:00 · UTC+5:45');
  assert.equal(h.time.dateTime, '2026-09-23T18:15:00.000Z');
  assert.equal(h.range.getAttribute('aria-valuetext'), '24 сентября, 00:00, UTC+5:45');
});

test('initial and loading states disable unavailable minutes without requiring a timeline', () => {
  const h = harness();
  h.update(state({ status: 'idle', timeline: null }));
  assert.equal(h.range.disabled, true);
  assert.equal(h.panel.getAttribute('aria-busy'), 'false');
  assert.equal(h.status.textContent, '');
  h.update(state({ status: 'loading', timeline: null }));
  assert.equal(h.panel.hidden, false);
  assert.equal(h.panel.getAttribute('aria-busy'), 'true');
  assert.equal(h.range.disabled, true);
  assert.equal(h.nowButton.disabled, true);
  assert.equal(h.status.textContent, 'Загружаем день…');
  assert.equal(h.date.textContent, '');
  assert.equal(h.time.textContent, '');
  assert.equal(h.range.getAttribute('aria-valuetext'), null);
});

test('loading and error retain minute labels, expose retry, then clear status on recovery', () => {
  const h = harness();
  h.update(state({ status: 'loading', index: 754 }));
  assert.equal(h.range.value, '754');
  assert.equal(h.time.textContent, '12:34 · UTC+5:45');
  assert.equal(h.range.getAttribute('aria-valuetext'), '24 сентября, 12:34, UTC+5:45');
  assert.equal(h.range.disabled, true);
  assert.equal(h.nowButton.disabled, true);
  h.update(state({ status: 'error', index: 754 }));
  assert.equal(h.panel.getAttribute('aria-busy'), 'false');
  assert.equal(h.status.textContent, 'День не загрузился');
  assert.equal(h.range.disabled, true);
  assert.equal(h.nowButton.disabled, false);
  assert.equal(h.nowButton.title, 'Повторить загрузку текущего дня');
  assert.equal(h.nowButton.textContent, 'Повторить');
  assert.equal(h.time.textContent, '12:34 · UTC+5:45');
  h.nowButton.dispatch('click');
  assert.deepEqual(h.nowCalls, [[]]);
  assert.deepEqual(h.scrubCalls, []);
  h.update(state({ index: 755 }));
  assert.equal(h.status.textContent, '');
  assert.equal(h.range.disabled, false);
  assert.equal(h.nowButton.disabled, false);
  assert.equal(h.nowButton.title, 'Вернуться к текущему времени');
  assert.equal(h.nowButton.textContent, 'Сейчас');
  assert.equal(h.nowButton.getAttribute('aria-pressed'), 'true');
  assert.equal(h.time.textContent, '12:35 · UTC+5:45');
  assert.equal(h.range.value, '755');
});

test('current-time marker uses the real reference index and exact endpoints of each local day length', () => {
  const h = harness();
  for (const [date, zone] of [
    ['2026-09-24', 'UTC'], ['2026-03-08', 'America/New_York'], ['2026-11-01', 'America/New_York'],
    ['2026-10-04', 'Australia/Lord_Howe'], ['2026-04-05', 'Australia/Lord_Howe'],
  ]) {
    const day = timeline(date, zone);
    for (const referenceIndex of [0, 300, day.minutes - 1]) {
      h.update(state({ timeline: day, index: 120, referenceIndex, live: false }));
      assert.equal(h.marker.hidden, false);
      assert.equal(h.marker.style.left, `${referenceIndex / (day.minutes - 1) * 100}%`);
      assert.equal(h.range.value, '120', 'the selected thumb remains independent of the clock marker');
    }
    assert.equal(h.marker.style.left, '100%');
  }
  h.update(state({ referenceIndex: -10 })); assert.equal(h.marker.style.left, '0%');
  h.update(state({ referenceIndex: 10000 })); assert.equal(h.marker.style.left, '100%');
  h.update(state({ timeline: { ...timeline(), minutes: 1 }, referenceIndex: 0 }));
  assert.equal(h.marker.style.left, '0%', 'a single available sample never creates NaN');
  assert.deepEqual(h.scrubCalls, []);
  assert.deepEqual(h.nowCalls, []);
});

test('marker-only updates preserve the selected time and aria-valuetext without dispatching input', () => {
  const h = harness();
  h.update(state({ index: 754, referenceIndex: 800, live: false }));
  const label = h.range.getAttribute('aria-valuetext'), shown = h.time.textContent, position = h.marker.style.left;
  h.update(state({ index: 754, referenceIndex: 801, live: false }));
  assert.notEqual(h.marker.style.left, position);
  assert.equal(h.range.value, '754');
  assert.equal(h.time.textContent, shown);
  assert.equal(h.range.getAttribute('aria-valuetext'), label);
  assert.deepEqual(h.scrubCalls, []);
  assert.deepEqual(h.nowCalls, []);
});

test('unavailable, stale and hidden transit states clear the marker while callers may omit it', () => {
  const h = harness();
  for (const overrides of [{ status: 'idle' }, { status: 'loading' }, { status: 'error' }, { timeline: null },
    { referenceIndex: null }, { referenceIndex: undefined }, { referenceIndex: NaN }, { wanted: false }]) {
    h.update(state({ referenceIndex: 500 }));
    assert.equal(h.marker.hidden, false);
    h.update(state(overrides));
    assert.equal(h.marker.hidden, true);
    assert.equal(h.marker.style.left, '');
  }
  const legacy = harness(false);
  legacy.update(state());
  legacy.update(state({ status: 'error', timeline: null }));
  assert.equal(legacy.nowButton.textContent, 'Повторить');
});
