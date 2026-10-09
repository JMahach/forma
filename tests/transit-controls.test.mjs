import test from 'node:test';
import assert from 'node:assert/strict';
import { attachTransitControls } from '../src/views/transit-controls.js';
import { createLocalDayTimeline } from '../src/domain/day-timeline.js';
import { dateDom } from './helpers/date-dom.mjs';

function element() {
  const attributes = new Map(), listeners = new Map();
  let captured = null;
  return {
    hidden: false, disabled: false, dataset: {}, style: { setProperty(name, value) { this[name] = value; } }, value: '', textContent: '', title: '', dateTime: '',
    setAttribute(name, value) { attributes.set(name, String(value)); },
    getAttribute(name) { return attributes.get(name) ?? null; },
    addEventListener(type, callback) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(callback);
    },
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 1044, height: 44 }),
    setPointerCapture(id) { captured = id; }, hasPointerCapture: id => captured === id,
    releasePointerCapture() { captured = null; },
    dispatch(type, options = {}) { for (const callback of listeners.get(type) || []) callback({ target: this,
      pointerId: 1, pointerType: 'mouse', button: 0, buttons: 0, clientX: 22, clientY: 22, preventDefault() {}, ...options }); },
  };
}

function harness(withMarker = true) {
  const elements = Object.fromEntries(['panel', 'range', 'status', 'retryButton', ...(withMarker ? ['marker'] : [])].map(name => [name, element()]));
  elements.hourMarks = dateDom().createElement('div');
  elements.range.closest = () => elements.panel.hidden ? elements.panel : null;
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

test('the reference follows the accepted UTC after manual scrubbing, not live mode or a pending index', () => {
  const h = harness(), day = timeline('2026-11-01', 'America/New_York');
  const at = index => ({ utc: new Date(day.startUtc + index * 60000).toISOString() });
  const update = overrides => h.update(state({ timeline: day, referenceIndex: 150, index: 150, live: false, current: at(150), ...overrides }));
  update(); assert.equal(h.marker.getAttribute('aria-pressed'), 'true', 'manual arrival lights the reference');
  update({ current: at(90), live: true });
  assert.equal(h.marker.getAttribute('aria-pressed'), 'false', 'same local minute in another fold is a different chart');
  update({ current: at(149) }); assert.equal(h.marker.getAttribute('aria-pressed'), 'false', 'requested index is not the displayed chart');
  update({ index: 149 }); assert.equal(h.marker.getAttribute('aria-pressed'), 'true', 'accepted chart still owns the reference');
  update({ referenceIndex: 151 }); assert.equal(h.marker.getAttribute('aria-pressed'), 'false', 'a paused chart does not follow the clock tick');
  update({ current: null }); assert.equal(h.marker.getAttribute('aria-pressed'), 'false');
  update({ referenceIndex: null }); assert.equal(h.marker.hidden, true);
  assert.deepEqual(h.nowCalls, []); assert.deepEqual(h.scrubCalls, []);
});

test('transit retry is error-only and needs no permanent Now button', () => {
  const panel = element(), range = element(), status = element(), retryButton = element();
  let retries = 0;
  const controls = attachTransitControls({ panel, range, status, retryButton, onScrub() {}, onNow() { retries++; } });
  controls.update(state());
  assert.equal(retryButton.hidden, true);
  retryButton.dispatch('click'); assert.equal(retries, 0);
  controls.update(state({ status: 'error' }));
  assert.equal(retryButton.hidden, false);
  retryButton.dispatch('click'); assert.equal(retries, 1);
  controls.update(state({ status: 'loading' }));
  assert.equal(retryButton.hidden, true);
});

test('hour marks follow actual local hours through short, long and half-hour transition days', () => {
  const h = harness();
  for (const [date, zone, count, sixIndex] of [
    ['2026-09-24', 'Asia/Kathmandu', 25, 360],
    ['2026-03-08', 'America/New_York', 24, 300],
    ['2026-11-01', 'America/New_York', 26, 420],
    ['2026-10-04', 'Australia/Lord_Howe', 24, 330],
    ['2026-04-05', 'Australia/Lord_Howe', 25, 390],
  ]) {
    const day = timeline(date, zone);
    h.update(state({ timeline: day }));
    const marks = h.hourMarks.children;
    assert.equal(marks.length, count, `${zone} ${date}`);
    const six = marks.find(mark => mark.children[0]?.textContent === '06');
    assert.equal(Number.parseFloat(six.style['--hour-position']), sixIndex / (day.minutes - 1) * 100);
    assert.equal(marks.at(-1).children[0].textContent, '24');
    assert.equal(marks.at(-1).style['--hour-position'], '100%');
    h.update(state({ timeline: day, index: 150 }));
    assert.equal(h.hourMarks.children, marks, 'scrubbing keeps the hour nodes');
  }
  h.update(state({ timeline: null, status: 'loading' }));
  assert.equal(h.hourMarks.children.length, 0, 'a new unloaded day cannot retain old hour marks');
});

test('day rail works without a duplicate date node and retains an accessible selected minute', () => {
  const panel = element(), range = element(), status = element(), retryButton = element();
  const controls = attachTransitControls({ panel, range, status, retryButton, onScrub() {}, onNow() {} });
  controls.update(state({ index: 754 }));
  assert.equal(range.value, '754');
  assert.match(range.getAttribute('aria-valuetext'), /12:34, UTC\+5:45/);
});

test('controls are visible only when transit is wanted, independently of readiness and live mode', () => {
  const h = harness();
  for (const status of ['idle', 'loading', 'ready', 'error']) {
    for (const wanted of [false, true]) {
      for (const live of [false, true]) {
        h.update(state({ status, wanted, live }));
        assert.equal(h.panel.hidden, !wanted);
        if (wanted) {
          assert.equal(h.panel.dataset.live, String(live));
          assert.equal(h.panel.dataset.status, status);
          assert.equal(h.retryButton.hidden, status !== 'error');
        }
      }
    }
  }
  assert.deepEqual(h.scrubCalls, [], 'rendering state never requests a minute change');
  assert.deepEqual(h.nowCalls, [], 'rendering state never requests a live refresh');
});

test('Lifetime coverage hides the ordinary panel while retaining the latest exact day state without owner callbacks', () => {
  const h = harness();
  h.update(state({ index: 754, live: false }));
  h.setCoveredByLifetime(true); assert.equal(h.panel.hidden, true);
  const day = timeline('2026-11-01', 'America/New_York');
  const next = Object.freeze(state({ timeline: day, index: 150, referenceIndex: 901, live: false, status: 'error' }));
  h.update(next);
  assert.equal(h.panel.hidden, true);
  h.setCoveredByLifetime(false);
  assert.equal(h.panel.hidden, false); assert.equal(h.range.value, '150');

  assert.equal(h.panel.dataset.status, 'error'); assert.equal(h.retryButton.textContent, 'Повторить');
  assert.equal(h.range.disabled, true); assert.equal(h.status.textContent, 'День не загрузился');
  assert.deepEqual(h.scrubCalls, []); assert.deepEqual(h.nowCalls, []);
});

test('hidden Day updates perform zero DOM writes or time formatting and reveal only the latest state', () => {
  const h = harness(), writes = [];
  h.update(state({ index: 754 })); h.setCoveredByLifetime(true);
  for (const name of ['panel', 'range', 'status', 'retryButton', 'marker']) {
    const element = h[name];
    for (const key of ['hidden', 'disabled', 'value', 'min', 'max', 'step', 'textContent', 'title', 'dateTime']) {
      let value = element[key];
      Object.defineProperty(element, key, { get: () => value, set(next) { value = next; writes.push(`${name}.${key}`); } });
    }
    for (const key of ['dataset', 'style']) element[key] = new Proxy(element[key], {
      set(target, property, value) { target[property] = value; writes.push(`${name}.${key}.${property}`); return true; },
    });
    const setAttribute = element.setAttribute;
    element.setAttribute = (key, value) => { writes.push(`${name}.${key}`); setAttribute(key, value); };
  }
  let formattingReads = 0;
  const day = timeline('2026-11-01', 'America/New_York');
  const hiddenDay = { ...day, get timeZone() { formattingReads++; return day.timeZone; } };
  for (let index = 119; index <= 150; index++) h.update(state({ timeline: hiddenDay, index, live: false, status: index === 150 ? 'error' : 'ready' }));
  assert.equal(writes.length, 0, '32 hidden updates must only replace latestState');
  assert.equal(formattingReads, 0);
  h.setCoveredByLifetime(false);
  assert.equal(h.range.value, '150');

  assert.equal(h.range.getAttribute('aria-valuetext'), '1 ноября, 01:30, UTC-5');
  assert.equal(h.retryButton.textContent, 'Повторить'); assert.equal(h.status.textContent, 'День не загрузился');
  assert.equal(h.range.value, '150', 'reveal projects the latest state once');
  assert.deepEqual(h.scrubCalls, []); assert.deepEqual(h.nowCalls, []);
});

for (const hiddenBy of ['Lifetime', 'owner']) test(`hiding Day by ${hiddenBy} releases a captured reference and hover before late pointer events`, () => {
  const h = harness(), ready = state({ index: 800, referenceIndex: 400, live: false });
  h.update(ready);
  const pointer = { clientX: 22 + 400 / 1439 * 1000, clientY: 22 };
  h.range.dispatch('pointermove', pointer);
  assert.equal(h.marker.getAttribute('data-hovered'), 'true');
  h.range.dispatch('pointerdown', pointer); assert.equal(h.range.hasPointerCapture(1), true);
  if (hiddenBy === 'Lifetime') h.setCoveredByLifetime(true); else h.update({ ...ready, wanted: false });
  assert.equal(h.range.hasPointerCapture(1), false);
  assert.equal(h.marker.hidden, true); assert.equal(h.marker.disabled, true);
  assert.equal(h.range.getAttribute('data-event-pressed'), 'false');
  assert.equal(h.marker.getAttribute('data-hovered'), 'false');
  h.range.dispatch('pointermove', { ...pointer, clientX: pointer.clientX + 200 });
  h.range.dispatch('pointerup', pointer); h.range.dispatch('input'); h.marker.dispatch('click');
  assert.deepEqual(h.scrubCalls, []); assert.deepEqual(h.nowCalls, []);
  if (hiddenBy === 'Lifetime') h.setCoveredByLifetime(false); else h.update(ready);
  h.marker.dispatch('click'); assert.deepEqual(h.nowCalls, [[]]);
});

test('ending Lifetime coverage reveals the ordinary panel only when its latest owner state wants transit', () => {
  const h = harness(); h.update(state()); h.setCoveredByLifetime(true);
  h.update(state({ wanted: false })); h.setCoveredByLifetime(false);
  assert.equal(h.panel.hidden, true, 'closing Lifetime cannot restore a panel after navigating away');
  h.setCoveredByLifetime(true); h.update(state({ wanted: true, index: 755 }));
  assert.equal(h.panel.hidden, true, 'a ready day cannot uncover the Lifetime rail');
  h.setCoveredByLifetime(false); assert.equal(h.panel.hidden, false); assert.equal(h.range.value, '755');
  h.update(state({ wanted: false })); assert.equal(h.panel.hidden, true);
  assert.deepEqual(h.scrubCalls, []); assert.deepEqual(h.nowCalls, []);
});

test('repeated coverage changes never duplicate ordinary slider or Now event delegation', () => {
  const h = harness(); h.update(state({ index: 120, referenceIndex: 754, live: false }));
  for (let index = 0; index < 5; index++) {
    h.setCoveredByLifetime(true); h.setCoveredByLifetime(true);
    h.setCoveredByLifetime(false); h.setCoveredByLifetime(false);
  }
  assert.deepEqual(h.scrubCalls, []); assert.deepEqual(h.nowCalls, []);
  h.range.value = '121'; h.range.dispatch('input'); h.marker.dispatch('click'); h.retryButton.dispatch('click');
  assert.deepEqual(h.scrubCalls, [[121]]); assert.deepEqual(h.nowCalls, [[]]);
  assert.equal(h.range.value, '121'); assert.equal(h.retryButton.hidden, true);
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

  }
});

test('input forwards the exact minute and the current-time marker delegates only its own callback', () => {
  const h = harness();
  h.update(state({ timeline: timeline('2026-11-01', 'America/New_York'), index: 90, live: false }));
  for (const minute of [0, 90, 119, 120, 150, 720, 1499]) {
    h.range.value = String(minute);
    h.range.dispatch('input');
  }
  assert.deepEqual(h.scrubCalls, [[0], [90], [119], [120], [150], [720], [1499]]);
  assert.deepEqual(h.nowCalls, []);
  h.marker.dispatch('click');
  assert.deepEqual(h.nowCalls, [[]], 'Now passes no event or minute to the live controller');
  assert.equal(h.scrubCalls.length, 7, 'Now does not initiate a second scrub');
  assert.equal(h.range.value, '1499', 'the owner supplies the refreshed current minute');
  assert.equal(h.marker.getAttribute('aria-pressed'), 'false', 'live mode changes when the owner publishes state');
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

test('repeated autumn clock times have distinct UTC offsets in accessible labels', () => {
  const h = harness();
  const day = timeline('2026-11-01', 'America/New_York');
  h.update(state({ timeline: day, index: 90, live: false }));

  assert.equal(h.range.getAttribute('aria-valuetext'), '1 ноября, 01:30, UTC-4');
  h.update(state({ timeline: day, index: 150, live: false }));

  assert.equal(h.range.getAttribute('aria-valuetext'), '1 ноября, 01:30, UTC-5');
});

test('spring minute labels skip nonexistent clock times and include fractional zone offsets', () => {
  const h = harness();
  const day = timeline('2026-03-08', 'America/New_York');
  h.update(state({ timeline: day, index: 119 }));
  assert.equal(h.range.getAttribute('aria-valuetext'), '8 марта, 01:59, UTC-5');
  h.update(state({ timeline: day, index: 120 }));

  assert.equal(h.range.getAttribute('aria-valuetext'), '8 марта, 03:00, UTC-4');
  h.update(state({ index: 0 }));

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
  assert.equal(h.retryButton.disabled, true);
  assert.equal(h.status.textContent, 'Загружаем день…');

  assert.equal(h.range.getAttribute('aria-valuetext'), null);
});

test('loading and error retain minute labels, expose retry, then clear status on recovery', () => {
  const h = harness();
  h.update(state({ status: 'loading', index: 754 }));
  assert.equal(h.range.value, '754');

  assert.equal(h.range.getAttribute('aria-valuetext'), '24 сентября, 12:34, UTC+5:45');
  assert.equal(h.range.disabled, true);
  assert.equal(h.retryButton.disabled, true);
  h.update(state({ status: 'error', index: 754 }));
  assert.equal(h.panel.getAttribute('aria-busy'), 'false');
  assert.equal(h.status.textContent, 'День не загрузился');
  assert.equal(h.range.disabled, true);
  assert.equal(h.retryButton.disabled, false);
  assert.equal(h.retryButton.title, 'Повторить загрузку текущего дня');
  assert.equal(h.retryButton.textContent, 'Повторить');

  h.retryButton.dispatch('click');
  assert.deepEqual(h.nowCalls, [[]]);
  assert.deepEqual(h.scrubCalls, []);
  h.update(state({ index: 755 }));
  assert.equal(h.status.textContent, '');
  assert.equal(h.range.disabled, false);
  assert.equal(h.retryButton.disabled, false);
  assert.equal(h.retryButton.hidden, true);

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
  const label = h.range.getAttribute('aria-valuetext'), position = h.marker.style.left;
  h.update(state({ index: 754, referenceIndex: 801, live: false }));
  assert.notEqual(h.marker.style.left, position);
  assert.equal(h.range.value, '754');

  assert.equal(h.range.getAttribute('aria-valuetext'), label);
  assert.deepEqual(h.scrubCalls, []);
  assert.deepEqual(h.nowCalls, []);
});

test('unchanged visible text survives marker, coverage and readiness updates without replacing its nodes', () => {
  const h = harness(), ready = state({ index: 754, referenceIndex: 800, live: false });
  h.update(ready);
  const writes = [];
  for (const name of ['status', 'retryButton']) {
    let value = h[name].textContent;
    Object.defineProperty(h[name], 'textContent', { get: () => value, set(next) { value = next; writes.push(name); } });
  }
  h.update({ ...ready, referenceIndex: 801 });
  h.setCoveredByLifetime(true); h.setCoveredByLifetime(false);
  assert.deepEqual(writes, []);
  assert.equal(h.marker.style.left, `${801 / 1439 * 100}%`);
  assert.equal(h.panel.hidden, false);
  h.update({ ...ready, status: 'loading' });
  assert.deepEqual(writes.splice(0), ['status']); assert.equal(h.range.disabled, true);
  h.update({ ...ready, status: 'error' });
  assert.deepEqual(writes.splice(0), ['status']); assert.equal(h.retryButton.disabled, false);
  h.update({ ...ready, index: 755 });
  assert.deepEqual(writes, ['status']);
  assert.equal(h.range.disabled, false);
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
  assert.equal(legacy.retryButton.textContent, 'Повторить');
});

test('the day rail announces the local date and unambiguous clock time', () => {
  const h=harness(); h.update(state({timeline:timeline('2026-11-01','America/New_York'),index:150}));
  assert.equal(h.range.getAttribute('aria-valuetext'), '1 ноября, 01:30, UTC-5');

});

test('transit reference tooltip says Current moment while retaining its accessible action', () => {
  const h = harness(); h.update(state());
  assert.equal(h.marker.title, 'Текущий момент');
  assert.equal(h.marker.getAttribute('aria-label'), 'Вернуться к текущему времени');
  h.range.dispatch('pointermove', { pointerType: 'mouse', buttons: 0, clientX: 22, clientY: 22 });
  assert.equal(h.range.title, 'Текущий момент');
});
