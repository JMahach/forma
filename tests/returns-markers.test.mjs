import test from 'node:test';
import assert from 'node:assert/strict';
import { dateDom } from './helpers/date-dom.mjs';
import { attachTimelineRange } from '../src/views/timeline-range.js';

import { groupReturnMarkers as group, attachReturnMarkers as attach } from '../src/views/returns-markers.js';
const event = (id, body, utc, pass = 1) => ({ id, body, utc, pass, cycle: 1, cycleId: `${body}:1`, direction: pass === 2 ? 'retrograde' : 'direct', age: 999 });
const fromUtc = '2026-01-01T00:00:00Z', toUtc = '2026-01-11T00:00:00Z';
const natal = { id: 'natal', utc: '2000-01-05T00:00:00Z', timezone: 'UTC' };

test('markers use actual chronological UTC positions, include both endpoints and leave input order intact', () => {
  const events = [event('last', 'uranus', toUtc), event('first', 'saturn', fromUtc), event('node', 'north_node', '2026-01-03T00:00:00Z'), event('chiron', 'chiron', '2026-01-08T00:00:00Z')];
  const result = group(events, { fromUtc, toUtc, width: 280 });
  assert.deepEqual(result.map(item => item.events.map(value => value.id)), [['first'], ['node'], ['chiron'], ['last']]);
  assert.deepEqual(result.map(item => item.position), [0, .2, .7, 1]);
  assert.deepEqual(events.map(value => value.id), ['last', 'first', 'node', 'chiron']);
});

test('only repeated passages of one cycle share a marker on both phone and desktop', () => {
  const events = [event('pass3', 'saturn', '2026-01-03T02:00:00Z', 3), event('node', 'north_node', '2026-01-04T00:00:00Z'), event('pass1', 'saturn', '2026-01-03T00:00:00Z'), event('far', 'chiron', '2026-01-09T00:00:00Z'), event('pass2', 'saturn', '2026-01-03T01:00:00Z', 2)];
  assert.deepEqual(group(events, { fromUtc, toUtc, width: 280 }).map(item => item.events.map(value => value.id)), [['pass1', 'pass2', 'pass3'], ['node'], ['far']]);
  assert.deepEqual(group(events, { fromUtc, toUtc, width: 1400 }).map(item => item.events.map(value => value.id)), [['pass1', 'pass2', 'pass3'], ['node'], ['far']]);
});

test('clipping away a first passage never promotes later passes and retains the next independent cycle', () => {
  const first = event('saturn-1', 'saturn', '2026-01-02T00:00:00Z');
  const second = event('saturn-2', 'saturn', '2026-01-04T00:00:00Z', 2);
  const third = event('saturn-3', 'saturn', '2026-01-06T00:00:00Z', 3);
  const next = { ...event('saturn-next', 'saturn', '2026-01-09T00:00:00Z'), cycle: 2, cycleId: 'saturn:2' };
  const events = [third, next, second, first], h = harness();
  h.update({ events });
  const nextButton = h.buttons()[1];
  for (const start of ['2026-01-03T00:00:00Z', '2026-01-05T00:00:00Z']) {
    assert.deepEqual(group(events, { fromUtc: start, toUtc, width: 280 }).map(item => item.events[0].id), [next.id]);
    h.update({ events, fromUtc: start });
    assert.deepEqual(h.buttons(), [nextButton], 'only the same next-cycle button remains');
  }
  assert.deepEqual(group([third, next, second], { fromUtc, toUtc, width: 280 }).map(item => item.events[0].id), [next.id], 'a list already clipped by its source cannot invent a first touch');
  nextButton.dispatch('click');
  assert.deepEqual(h.chosen, [next]);
});

test('markers include selected fast returns and Jupiter while excluding invalid moments and events outside the scale', () => {
  const events = [event('before', 'saturn', '2025-12-31T23:59:59Z'), event('jupiter', 'jupiter', '2026-01-05T00:00:00Z'), event('solar', 'sun', '2026-01-05T00:00:00Z'), event('invalid', 'chiron', 'bad'), event('opposition', 'uranus_opposition', '2026-01-05T00:00:00Z'), event('after', 'uranus', '2026-01-11T00:00:01Z')];
  assert.deepEqual(group(events, { fromUtc, toUtc, width: 280 }).flatMap(item => item.events.map(value => value.id)), ['jupiter', 'solar', 'opposition']);
  assert.deepEqual(group(events, { fromUtc: 'bad', toUtc, width: 280 }), []);
  assert.deepEqual(group(events, { fromUtc: toUtc, toUtc: fromUtc, width: 280 }), []);
  assert.equal(group([event('point', 'saturn', fromUtc)], { fromUtc, toUtc: fromUtc, width: 280 })[0].position, .5);
});

test('free return labels sit below, with collisions and the complete endpoint caption zones reserved above', () => {
  const events = [
    event('near-birth', 'sun', '2026-01-03T00:00:00Z'),
    event('free', 'saturn', '2026-01-04T00:00:00Z'),
    event('neighbor', 'north_node', '2026-01-04T06:00:00Z'),
    event('free-later', 'chiron', '2026-01-07T00:00:00Z'),
    event('near-century', 'uranus', '2026-01-09T00:00:00Z'),
  ];
  const groups = group(events, { fromUtc, toUtc, width: 280 });
  assert.deepEqual(groups.map(item => item.labelLane), ['above', 'below', 'above', 'below', 'above']);
  assert.deepEqual(groups.map(item => item.position), [.2, .3, .325, .6, .8]);
  assert.ok(groups.every(item => !item.labelHidden));
  assert.ok(groups.filter(item => item.labelLane === 'below').every(item => item.labelOffset === 0));
});

test('dense lunar events retain exact positions without pushing visible labels beyond the rail', () => {
  const values = Array.from({ length: 1336 }, (_, i) => ({
    ...event('moon-' + i, 'moon', new Date(Date.parse(fromUtc) + i * 600000).toISOString()), cycle: i + 1,
  }));
  const groups = group(values, { fromUtc, toUtc, width: 236 });
  assert.equal(groups.length, 1336);
  const visible = groups.filter(item => !item.labelHidden);
  assert.ok(visible.length > 1 && visible.length < 30);
  for (const item of visible) {
    const x = item.position * 236 + item.labelOffset;
    assert.ok(x >= 0 && x <= 236, 'labels remain within the rail');
  }
});

function harness(options = {}) {
  const document = dateDom();
  const container = document.createElement('div'), slider = document.createElement('input');
  let width = 324;
  const observers = [];
  document.defaultView.ResizeObserver = class {
    constructor(callback) { this.callback = callback; }
    observe(target) { observers.push({ target, callback: this.callback }); }
  };
  container.getBoundingClientRect = () => ({ width });
  slider.type = 'range'; container.append(slider); document.body.append(container);
  Object.assign(slider, { min: '0', max: '1000', step: '1', value: '1000',
    getBoundingClientRect: () => ({ left: 10, top: 30, width, height: 44 }) });
  container.querySelector = selector => selector === 'input[type="range"]' ? slider : null;
  let day, refreshes = 0;
  const chosen = [], markers = attach({ container, onSelect: value => chosen.push(value), onTargetsChange: () => { refreshes++; day?.refreshTargets(); }, ...options });
  const layer = container.children.at(-1);
  const reference = document.createElement('button'), now = [], scrubs = [];
  day = attachTimelineRange({ range: slider, marker: reference, resolveTap: (pointer, metrics) => markers.hitTest(pointer, metrics),
    onReference: () => now.push(true), onScrub: value => scrubs.push(value) });
  day.updateReference({ visible: false, label: 'Сейчас' });
  const buttons = () => layer.all(node => node.tagName === 'button' && node.className === 'returns-marker');
  const update = extra => markers.update({ events: [], natal, fromUtc, toUtc, visible: true, displayedUtc: extra.selectedEvent?.utc, ...extra });
  return { document, container, slider, chosen, markers, layer, buttons, update, reference, now, scrubs, day,
    get refreshes() { return refreshes; },
    resize(value) { width = value; for (const { target, callback } of observers) callback([{ target, contentRect: { width } }]); } };
}

test('every event lights from accepted UTC without selection id, including coincident events', () => {
  const a = event('saturn', 'saturn', fromUtc), b = event('uranus', 'uranus_opposition', fromUtc);
  const c = event('node', 'north_node', toUtc), h = harness(), events = [a, b, c];
  h.update({ events, displayedUtc: new Date(fromUtc).toISOString() });
  assert.deepEqual(h.buttons().map(button => button.getAttribute('aria-pressed')), ['true', 'true', 'false']);
  h.update({ events, selectedEvent: a, displayedUtc: toUtc });
  assert.deepEqual(h.buttons().map(button => button.getAttribute('aria-pressed')), ['false', 'false', 'true'], 'old selection is not the chart');
  h.update({ events, selectedEvent: c, displayedUtc: null });
  assert.ok(h.buttons().every(button => button.getAttribute('aria-pressed') === 'false'));
  assert.deepEqual(h.chosen, []);
});

test('event contact previews across a drag, clears on cancel and preserves published selection', () => {
  const h = harness(), value = event('saturn', 'saturn', fromUtc);
  h.update({ events: [value] }); const button = h.buttons()[0];
  let reads = 0;
  for (const element of button.children) element.getBoundingClientRect = () => {
    reads++; return { left: 50, top: 50, width: 5, height: 5 };
  };
  const pointer = { pointerId: 1, button: 0, pointerType: 'touch', buttons: 1, clientX: 52, clientY: 52 };
  h.slider.dispatch('pointerdown', pointer);
  assert.equal(button.dataset.pressed, 'true'); assert.deepEqual(h.chosen, []);
  reads = 0;
  h.slider.dispatch('pointermove', { ...pointer, clientX: 150 });
  assert.notEqual(button.dataset.pressed, 'true');
  h.slider.dispatch('pointermove', pointer); assert.equal(button.dataset.pressed, 'true');
  assert.equal(reads, 0, 'drag reuses its hit geometry');
  h.update({ events: [value], displayedUtc: value.utc });
  h.slider.dispatch('pointercancel', pointer);
  assert.notEqual(button.dataset.pressed, 'true'); assert.equal(button.getAttribute('aria-pressed'), 'true');
  assert.deepEqual(h.chosen, []);
});

test('single compact node selects its exact event, labels actual date and completed age, and preserves the existing slider', () => {
  const h = harness(), value = event('first', 'saturn', fromUtc);
  h.update({ events: [value], selectedEvent: value });
  const button = h.buttons()[0];
  assert.equal(h.container.children[0], h.slider); assert.equal(h.container.children.filter(node => node.tagName === 'input').length, 1);
  assert.equal(button.style.left, '0%'); assert.equal(button.getAttribute('aria-pressed'), 'true');
  assert.match(button.getAttribute('aria-label'), /Сатурна/); assert.match(button.title, /2026/); assert.match(button.title, /25 лет/); assert.doesNotMatch(button.title, /999/);
  assert.equal(button.children.map(child => child.textContent).join(''), '♄1'); assert.equal(button.children[0].className, 'returns-marker-dot');
  button.dispatch('click'); assert.equal(h.chosen[0], value);
  h.update({ events: [value], selectedEvent: value }); assert.equal(h.buttons()[0], button, 'clock-only updates keep the node and its focus');
});

test('nearby first passages retain their exact positions without promoting an isolated later pass', () => {
  const later = event('later', 'saturn', '2026-01-03T01:00:00Z', 2), first = event('first', 'north_node', '2026-01-03T00:00:00Z');
  const values = [later, first, event('last', 'chiron', '2026-01-03T02:00:00Z')];
  const grouped = group(values, { fromUtc, toUtc, width: 280 });
  assert.equal(grouped[0].position, .2); assert.deepEqual(grouped.map(item => item.events.map(value => value.id)), [['first'], ['last']]);
  const h = harness(); h.update({ events: values }); const button = h.buttons()[0];
  assert.equal(button.style.left, '20%'); assert.equal(button.children.map(child => child.textContent).join(''), '☊1');
  assert.match(button.title, /лунных узлов/); assert.doesNotMatch(button.title, /Сатурна|Хирона/);
  button.dispatch('click'); assert.equal(h.chosen.length, 1); assert.equal(h.chosen[0], first);
  assert.equal(h.layer.all(node => node.getAttribute('role') === 'dialog').length, 0);
  assert.equal(button.getAttribute('aria-haspopup'), null);
});
test('selecting a hidden later event does not mark the first node selected', () => {
  const values = [event('first', 'saturn', '2026-01-03T00:00:00Z'), event('second', 'saturn', '2026-01-03T01:00:00Z', 2)];
  const h = harness(); h.update({ events: values, selectedEvent: values[1] });
  assert.equal(h.buttons()[0].getAttribute('aria-pressed'), 'false');
  h.update({ events: values, visible: false }); assert.equal(h.layer.hidden, true); assert.equal(h.buttons().length, 0);
  h.update({ events: values, fromUtc: '2026-01-04T00:00:00Z' }); assert.equal(h.buttons().length, 0);
});
test('first-event selection with missing natal data never invents an age', () => {
  const h = harness(), values = [event('first', 'saturn', '2026-01-03T00:00:00Z'), event('second', 'saturn', '2026-01-03T01:00:00Z', 2)];
  h.update({ events: values, natal: null }); h.buttons()[0].dispatch('click');
  assert.equal(h.chosen[0], values[0]); assert.doesNotMatch(h.buttons()[0].title, /лет|год|999/);
});

test('each life event node visibly identifies its planet using a compact hidden-from-ARIA glyph', () => {
  for (const [body, glyph] of [['saturn', '♄'], ['north_node', '☊'], ['uranus_opposition', '♅½'], ['uranus', '♅'], ['chiron', '⚷']]) {
    const h = harness(); h.update({ events: [event(body, body, fromUtc)] }); const button = h.buttons()[0];
    const symbol = button.children.find(child => child.className === 'returns-marker-symbol');
    assert.ok(symbol, `visible identifier for ${body}`); assert.equal(symbol.textContent, glyph + (body === 'uranus_opposition' ? '' : '1')); assert.equal(symbol.getAttribute('aria-hidden'), 'true');
    assert.equal(button.style.left, '0%'); assert.equal(button.children.map(child => child.textContent).join(''), glyph + (body === 'uranus_opposition' ? '' : '1'));
    assert.equal(button.children.filter(child => child.className === 'returns-marker-dot').length, 1);
  }
});
test('the first passage represents its own cycle without swallowing other planet cycles', () => {
  const values = [event('saturn-first', 'saturn', '2026-01-03T00:00:00Z'), event('saturn-again', 'saturn', '2026-01-03T00:00:01Z', 2),
    event('node', 'north_node', '2026-01-03T00:00:02Z'), event('opposition', 'uranus_opposition', '2026-01-03T00:00:03Z'),
    event('uranus', 'uranus', '2026-01-03T00:00:04Z'), event('chiron', 'chiron', '2026-01-03T00:00:05Z')];
  const h = harness(); h.update({ events: values }); assert.equal(h.buttons().length, 5);
  const symbol = h.buttons()[0].children.find(child => child.className === 'returns-marker-symbol');
  assert.ok(symbol); assert.equal(symbol.textContent, '♄1'); assert.equal(symbol.getAttribute('aria-hidden'), 'true');
  h.buttons()[0].dispatch('click');
  assert.equal(h.chosen[0], values[0]);
  assert.deepEqual(group(values, { fromUtc, toUtc, width: 280 }).flatMap(item => item.events.map(value => value.id)), values.map(value => value.id));
});


const lifeBirth = '1998-08-18T12:00:00Z', lifeEnd = '2118-08-18T12:00:00Z';
const lifeEvent = (body, cycle, utc, pass = 1) => ({ ...event(`${body}:${cycle}:${pass}`, body, utc, pass), cycle, cycleId: `${body}:${cycle}` });
test('Saturn 2 remains an independent exact marker beside lunar nodes 3 on a 120-year rail', () => {
  const node = lifeEvent('north_node', 3, '2054-06-24T12:00:00Z');
  const saturn = lifeEvent('saturn', 2, '2057-06-24T23:27:34.429422Z');
  const repeat = lifeEvent('saturn', 2, '2057-10-11T07:26:50.383607Z', 2);
  const last = lifeEvent('saturn', 2, '2058-03-14T22:49:52.764361Z', 3);
  for (const width of [236, 280, 636]) {
    const groups = group([repeat, node, last, saturn], { fromUtc: lifeBirth, toUtc: lifeEnd, width });
    assert.equal(groups.length, 2);
    const second = groups.find(item => item.events[0].body === 'saturn');
    assert.ok(second); assert.equal(second.events[0], saturn);
    assert.deepEqual(second.events.map(value => value.id), [saturn, repeat, last].map(value => value.id));
    assert.equal(second.position, (Date.parse(saturn.utc)-Date.parse(lifeBirth))/(Date.parse(lifeEnd)-Date.parse(lifeBirth)));
  }
});
test('a chain of nearby independent cycles cannot reduce decades of the rail to its first marker', () => {
  const values = Array.from({ length: 8 }, (_, index) => lifeEvent(index % 2 ? 'saturn' : 'north_node', index + 1, `${2010 + index * 10}-01-01T00:00:00Z`));
  const groups = group(values, { fromUtc: lifeBirth, toUtc: lifeEnd, width: 280 });
  assert.deepEqual(groups.map(item => item.events[0].id), values.map(item => item.id));
});
test('visible marker and accessible label identify Saturn cycle 2, while nearby cycles stay selectable', () => {
  const h = harness();
  const values = [lifeEvent('north_node', 3, '2054-06-24T12:00:00Z'), lifeEvent('saturn', 2, '2057-06-24T23:27:34.429422Z')];
  h.update({ events: values, fromUtc: lifeBirth, toUtc: lifeEnd, natal: { ...natal, utc: lifeBirth } });
  assert.equal(h.buttons().length, 2);
  const button = h.buttons().find(item => item.dataset.returnMarker === values[1].id);
  assert.ok(button); assert.match(button.title, /Возврат Сатурна 2/); assert.match(button.getAttribute('aria-label'), /Возврат Сатурна 2/);
  assert.equal(button.children.find(child => child.className === 'returns-marker-symbol').textContent, '♄2');
  assert.notEqual(button.dataset.labelLane, h.buttons()[0].dataset.labelLane);
  button.dispatch('click'); assert.equal(h.chosen[0], values[1]);
});


test('lower labels leave birth and age endpoint captions clear without moving exact node positions', () => {
  const values = [lifeEvent('north_node', 6, '2110-01-01T00:00:00Z'), lifeEvent('saturn', 4, '2116-01-01T00:00:00Z')];
  const groups = group(values, { fromUtc: lifeBirth, toUtc: lifeEnd, width: 280 });
  assert.equal(groups.length, 2);
  assert.ok(groups.every(item => item.labelLane === 'above'));
  for (const item of groups) assert.equal(item.position, (Date.parse(item.events[0].utc)-Date.parse(lifeBirth))/(Date.parse(lifeEnd)-Date.parse(lifeBirth)));
  const visible = groups.filter(item => !item.labelHidden);
  assert.ok(visible.length > 0);
  assert.ok(visible.every(item => item.position * 280 + item.labelOffset <= 269));
  for (let i = 1; i < visible.length; i++) assert.ok(visible[i].position * 280 + visible[i].labelOffset - (visible[i - 1].position * 280 + visible[i - 1].labelOffset) >= 20);
});

test('mouse, touch and pen select near a tiny mark while preserving nearby events and direct labels', () => {
  const h = harness(), a = event('saturn', 'saturn', fromUtc), b = event('node', 'north_node', toUtc);
  h.update({ events: [a, b] });
  const rect = (left, top, width, height) => ({ left, top, width, height, right: left + width, bottom: top + height });
  const [first, second] = h.buttons();
  first.children[0].getBoundingClientRect = () => rect(50, 50, 5, 5);
  first.children[1].getBoundingClientRect = () => rect(65, 28, 20, 16);
  second.children[0].getBoundingClientRect = () => rect(70, 50, 5, 5);
  second.children[1].getBoundingClientRect = () => rect(66, 65, 20, 16);
  let near;
  for (const pointerType of ['mouse', 'touch', 'pen']) {
    near = h.markers.hitTest({ clientX: 40, clientY: 51, pointerType });
    assert.ok(near, pointerType); near.select(); assert.equal(h.chosen.at(-1), a);
    const nearest = h.markers.hitTest({ clientX: 65, clientY: 52, pointerType });
    nearest.select(); assert.equal(h.chosen.at(-1), b);
    const label = h.markers.hitTest({ clientX: 73, clientY: 42, pointerType });
    label.select(); assert.equal(h.chosen.at(-1), a);
    assert.equal(h.markers.hitTest({ clientX: 200, clientY: 100, pointerType }), null);
  }
  h.update({ events: [a, b], visible: false });
  assert.equal(near.valid(), false);
});

test('mouse hover on the shared range exposes the exact marker label without selecting it', () => {
  const h = harness(), value = event('saturn', 'saturn', '2026-01-03T12:36:05.920Z');
  h.update({ events: [value] });
  const button = h.buttons()[0];
  button.children[0].getBoundingClientRect = () => ({ left: 50, top: 50, width: 5, height: 5 });
  button.children[1].getBoundingClientRect = () => ({ left: 42, top: 29, width: 20, height: 16 });
  h.slider.dispatch('pointermove', { pointerType: 'mouse', buttons: 0, clientX: 40, clientY: 52 });
  assert.match(h.slider.title, /Возврат Сатурна 1/);
  assert.deepEqual(h.slider.title.split('\n'), [
    'Возврат Сатурна 1 · 25 лет',
    '3 января 2026 г. в 12:36:05',
    'UTC · прямой ход',
  ]);
  assert.equal(button.dataset.hovered, 'true'); assert.deepEqual(h.chosen, []);
  button.dispatch('click', { detail: 0 }); button.dispatch('click', { detail: 1 });
  assert.deepEqual(h.chosen, [value], 'keyboard selects once; pointer clicks stay owned by the range');
});

test('marker hover clears off-target, on leaving, dragging and hiding without drag-time geometry reads', () => {
  const h = harness(), value = event('saturn', 'saturn', fromUtc);
  h.update({ events: [value] });
  const button = h.buttons()[0]; let reads = 0;
  for (const element of button.children) element.getBoundingClientRect = () => {
    reads++; return { left: 50, top: 50, width: 5, height: 5 };
  };
  const pointer = { pointerType: 'mouse', buttons: 0, clientX: 52, clientY: 52 };
  const hover = () => { h.slider.dispatch('pointermove', pointer); assert.ok(h.slider.title); assert.equal(button.dataset.hovered, 'true'); };
  const cleared = () => { assert.equal(h.slider.title, ''); assert.notEqual(button.dataset.hovered, 'true'); };
  hover(); h.slider.dispatch('pointermove', { ...pointer, clientX: 200 }); cleared();
  hover(); h.slider.dispatch('pointerleave', pointer); cleared();
  hover(); h.slider.dispatch('pointerdown', { ...pointer, buttons: 1 }); cleared();
  reads = 0;
  h.slider.dispatch('pointermove', { ...pointer, buttons: 1 });
  assert.equal(reads, 0); cleared();
  hover(); h.update({ events: [] }); cleared();
  h.update({ events: [value] });
  const replacement = h.buttons()[0];
  for (const child of replacement.children) child.getBoundingClientRect = () => ({ left: 50, top: 50, width: 5, height: 5 });
  h.slider.dispatch('pointermove', pointer); assert.ok(h.slider.title);
  h.update({ events: [value], visible: false });
  assert.equal(h.slider.title, ''); assert.notEqual(replacement.dataset.hovered, 'true');
  assert.deepEqual(h.chosen, []);
});

test('clock and selected-event updates reuse marker geometry, formatters and focused buttons', t => {
  const h = harness(), values = [event('saturn', 'saturn', fromUtc), event('node', 'north_node', toUtc)];
  h.update({ events: values, selectedEvent: values[0] });
  const [first, second] = h.buttons(); first.focus();
  const refreshes = h.refreshes;
  let reads = 0, formats = 0;
  const measure = h.container.getBoundingClientRect, Format = Intl.DateTimeFormat;
  h.container.getBoundingClientRect = () => { reads++; return measure(); };
  t.mock.method(Intl, 'DateTimeFormat', function(...args) { formats++; return new Format(...args); });
  for (let index = 0; index < 50; index++) h.update({ events: [...values], natal: { ...natal }, selectedEvent: values[index % 2] });
  assert.equal(reads, 0, 'state updates do not measure layout');
  assert.equal(h.refreshes, refreshes, 'clock-only updates never invalidate targets or re-enter render');
  assert.equal(formats, 0, 'an unchanged birth and zone reuse the formatter');
  assert.equal(h.buttons()[0], first); assert.equal(h.buttons()[1], second);
  assert.equal(h.document.activeElement, first); assert.equal(h.layer.contains(first), true);
  assert.equal(first.getAttribute('aria-pressed'), 'false'); assert.equal(second.getAttribute('aria-pressed'), 'true');
});

test('resizing and inserting nearby events retain existing focused nodes and update label lanes', () => {
  const h = harness(), first = event('saturn', 'saturn', '2026-01-05T00:00:00Z');
  const later = event('node', 'north_node', '2026-01-05T12:00:00Z');
  h.update({ events: [first, later] });
  const [button, neighbor] = h.buttons(); button.focus();
  assert.equal(button.dataset.labelLane, 'below');
  assert.equal(neighbor.dataset.labelLane, 'above');
  h.resize(1044);
  assert.equal(h.buttons()[0], button); assert.equal(h.buttons()[1], neighbor);
  assert.equal(neighbor.dataset.labelLane, 'below');
  const early = event('chiron', 'chiron', fromUtc), corrected = { ...first, utc: '2026-01-04T00:00:00Z' };
  h.update({ events: [early, corrected, later] });
  assert.equal(h.buttons()[1], button); assert.equal(h.buttons()[2], neighbor);
  assert.equal(h.document.activeElement, button); assert.equal(h.layer.contains(button), true);
  assert.equal(button.style.left, '30%');
  button.dispatch('click'); assert.equal(h.chosen.at(-1), corrected, 'retained keyboard action uses the latest event');
});

test('shared hover and click keep Now above a neighboring expanded return target', () => {
  const h = harness(), value = event('saturn', 'saturn', fromUtc);
  h.update({ events: [value] });
  const button = h.buttons()[0];
  button.children[0].getBoundingClientRect = () => ({ left: 62.5, top: 49.5, width: 5, height: 5 });
  button.children[1].getBoundingClientRect = () => ({ left: 55, top: 28, width: 20, height: 16 });
  h.day.updateReference({ value: 1000 / 14, visible: true, label: 'Сейчас' });
  const pointer = { pointerType: 'mouse', pointerId: 1, isPrimary: true, button: 0, buttons: 0, clientX: 52, clientY: 52 };
  h.slider.dispatch('pointermove', pointer);
  assert.notEqual(button.dataset.hovered, 'true');
  assert.equal(h.reference.getAttribute('data-hovered'), 'true'); assert.equal(h.slider.title, 'Сейчас');
  h.slider.dispatch('pointerdown', { ...pointer, buttons: 1 }); h.slider.dispatch('pointerup', pointer);
  assert.deepEqual(h.now, [true]); assert.deepEqual(h.chosen, []); assert.deepEqual(h.scrubs, []);
  h.slider.dispatch('pointermove', { ...pointer, clientX: 65, clientY: 36 });
  assert.equal(button.dataset.hovered, 'true'); assert.equal(h.reference.getAttribute('data-hovered'), 'false');
  assert.match(h.slider.title, /Сатурна/, 'a direct visible label retains its own target');
});

test('the selected thumb keeps its moment when a nearby return only has an expanded hit', () => {
  const h = harness(), value = event('saturn', 'saturn', fromUtc);
  h.update({ events: [value] }); h.slider.value = String(1000 / 14);
  const button = h.buttons()[0];
  button.children[0].getBoundingClientRect = () => ({ left: 62.5, top: 49.5, width: 5, height: 5 });
  button.children[1].getBoundingClientRect = () => ({ left: 55, top: 28, width: 20, height: 16 });
  const pointer = { pointerType: 'mouse', pointerId: 1, isPrimary: true, button: 0, buttons: 0, clientX: 52, clientY: 52 };
  h.slider.dispatch('pointermove', pointer);
  assert.notEqual(button.dataset.hovered, 'true'); assert.notEqual(h.slider.getAttribute('data-event-hovered'), 'true');
  h.slider.dispatch('pointerdown', { ...pointer, buttons: 1 }); h.slider.dispatch('pointerup', pointer);
  assert.deepEqual(h.chosen, []); assert.deepEqual(h.scrubs, []);
});

test('a pending exact tap cannot select a moved event through its retained button', () => {
  const h = harness(), value = event('saturn', 'saturn', fromUtc);
  h.update({ events: [value] });
  const button = h.buttons()[0];
  for (const child of button.children) child.getBoundingClientRect = () => ({ left: 50, top: 50, width: 5, height: 5 });
  const target = h.markers.hitTest({ pointerType: 'mouse', clientX: 52, clientY: 52 });
  value.utc = toUtc; h.update({ events: [value] });
  assert.equal(h.buttons()[0], button); assert.equal(button.style.left, '100%');
  assert.equal(target.valid(), false);
  target.select(); assert.deepEqual(h.chosen, []);
});

test('event tooltip has three readable lines without a passage counter', () => {
  const h = harness(), value = { ...event('saturn', 'saturn', '2057-06-24T23:20:37Z'), cycle: 2 };
  h.update({ events: [value], natal: { utc: '1998-08-18T14:00:00Z', timezone: 'Europe/Moscow' },
    fromUtc: '1998-08-18T14:00:00Z', toUtc: '2098-08-18T14:00:00Z' });
  assert.deepEqual(h.buttons()[0].title.split('\n'), [
    'Возврат Сатурна 2 · 58 лет',
    '25 июня 2057 г. в 02:20:37',
    'Europe/Moscow · прямой ход',
  ]);
});


test('removing a contacted target cancels its pending tap without selecting or recursive rendering', () => {
  const h = harness(), value = event('saturn', 'saturn', fromUtc);
  h.update({ events: [value] });
  const button = h.buttons()[0];
  for (const child of button.children) child.getBoundingClientRect = () => ({ left: 50, top: 50, width: 5, height: 5 });
  const pointer = { pointerType: 'touch', pointerId: 1, button: 0, buttons: 1, clientX: 52, clientY: 52 };
  h.slider.dispatch('pointerdown', pointer);
  assert.equal(button.dataset.pressed, 'true');
  const refreshes = h.refreshes;
  h.update({ events: [] });
  assert.notEqual(button.dataset.pressed, 'true');
  assert.equal(h.refreshes, refreshes + 1, 'one layout change produces exactly one invalidation');
  h.slider.dispatch('pointerup', { ...pointer, buttons: 0 });
  assert.deepEqual(h.chosen, []);
  assert.equal(h.slider.title, '');
});
