import test from 'node:test';
import assert from 'node:assert/strict';
import { renderReturnEvents, attachReturnsPanel } from '../src/views/returns-panel.js';
import { returnFooter, returnAge, updateReturnClock } from '../src/views/returns-clock.js';
import { readFileSync } from 'node:fs';
import { SVG_NS, svgDocument } from './helpers/svg-dom.mjs';
import { dateDom } from './helpers/date-dom.mjs';

const natal = { name: 'Личная карта', utc: '1996-10-04T12:00:00Z', timezone: 'Europe/Moscow' };
const event = (body, utc, cycle = 1, pass = 1) => ({ body, utc, cycle, pass, cycleId: `${body}:${cycle}`, id: `${body}:${utc}`, direction: pass === 2 ? 'retrograde' : 'direct', age: 29.5 });
test('return footer describes the selected event, its local time and completed age, never today', () => {
  const selectedEvent = event('saturn', '2076-10-03T22:30:00Z');
  const footer = returnFooter({ natal, selectedEvent });
  assert.equal(footer.date, '4 октября 2076');
  assert.equal(footer.detail, '01:30 · 80 лет');
  assert.equal(footer.utc, selectedEvent.utc);
  assert.equal(returnAge('2076-10-03T12:00:00Z', natal), 79);
  assert.equal(returnAge(natal.utc, natal), 0);
});
test('the list shows only the first exact touch of each independent cycle without changing stored passages', () => {
  const events = Object.freeze([event('saturn', '2026-10-01T00:00:00Z', 1, 3), event('jupiter', '2025-03-01T00:00:00Z'), event('saturn', '2026-04-01T00:00:00Z'), event('saturn', '2026-08-01T00:00:00Z', 1, 2), event('saturn', '2056-04-01T00:00:00Z', 2)].map(Object.freeze));
  const before = JSON.stringify(events);
  const markup = renderReturnEvents({ natal, events, selectedEvent: events[3] }, Date.parse('2026-01-01T00:00:00Z'));
  assert.deepEqual([...markup.matchAll(/data-return-event="([^"]+)"/g)].map(match => match[1]), [events[1].id, events[2].id, events[4].id]);
  assert.doesNotMatch(markup, /<details|Проход|прохода|ретроградный ход/);
  assert.doesNotMatch(markup, /aria-pressed="true"/, 'a selected later touch does not mislabel the first touch as selected');
  assert.equal(returnFooter({ natal, selectedEvent: events[3] }).utc, events[3].utc);
  assert.equal(JSON.stringify(events), before);
});

test('a yearly window never promotes later touches when the first touch was in the previous year', () => {
  const second = event('saturn', '2026-01-10T12:36:05.920Z', 1, 2), third = event('saturn', '2026-03-01T12:36:05.920Z', 1, 3);
  const nextCycle = event('sun', '2026-10-04T12:00:00Z', 30, 1);
  const h = panelHarness();
  h.update({ timelineVisible: true, opened: true, group: 'year', year: 2026, events: [third, nextCycle, second], selectedEvent: third });
  assert.deepEqual([...h.nodes.returnsContent.innerHTML.matchAll(/data-return-event="([^"]+)"/g)].map(match => match[1]), [nextCycle.id]);
  assert.equal(h.nodes.returnsDate.dateTime, third.utc, 'the existing exact selected chart retains its later touch');
  h.update({ events: [third, second] });
  assert.equal(h.nodes.returnsContent.innerHTML, '');
  assert.equal(h.nodes.returnsStatus.textContent, 'В этом периоде первых касаний нет.');
  assert.equal(h.nodes.returnsDate.dateTime, third.utc);
});
test('return list safely prints names and marks the chronological present without fabricated events', () => {
  const events = [event('sun', '2026-03-01T00:00:00Z'), event('saturn', '2027-01-01T00:00:00Z')];
  const markup = renderReturnEvents({ natal, events }, Date.parse('2026-06-01T00:00:00Z'));
  assert.ok(markup.indexOf('2026-03-01') < markup.indexOf('Сейчас'));
  assert.ok(markup.indexOf('Сейчас') < markup.indexOf('2027-01-01'));
  assert.equal(renderReturnEvents({ natal, events: [] }), '');
});

test('each event is one full-row button with no nested action target', () => {
  const document = svgDocument(), root = document.createElementNS(SVG_NS, 'g');
  root.innerHTML = renderReturnEvents({ natal, events: [event('saturn', '2027-01-01T00:00:00Z')] });
  const button = root.querySelector('[data-return-event]');
  assert.equal(button.tagName, 'button');
  assert.equal(button.classList.contains('returns-event'), true);
  assert.equal(button.querySelectorAll('button').length, 0);
  assert.ok(button.querySelector('time')); assert.ok(button.querySelector('strong'));
});

test('a hidden drawer defers new rows until it opens', () => {
  const h = panelHarness(), first = event('saturn', '2027-01-01T00:00:00Z'), next = event('sun', '2028-01-01T00:00:00Z');
  h.update({ timelineVisible: true, opened: true, events: [first] });
  const before = h.nodes.returnsContent.innerHTML;
  h.update({ opened: false, events: [next] });
  assert.equal(h.nodes.returnsContent.innerHTML, before);
  h.update({ opened: true });
  assert.match(h.nodes.returnsContent.innerHTML, /2028-01-01/);
  assert.doesNotMatch(h.nodes.returnsContent.innerHTML, /2027-01-01/);
});

test('a closed drawer prepares only the latest event list when it opens', () => {
  const h = panelHarness(), first = event('saturn', '2027-01-01T00:00:00Z'), next = event('sun', '2028-01-01T00:00:00Z');
  let firstReads = 0, nextReads = 0;
  Object.defineProperty(first, 'pass', { get() { firstReads++; return 1; } });
  Object.defineProperty(next, 'pass', { get() { nextReads++; return 1; } });
  h.update({ timelineVisible: true, events: [first], group: 'planet' });
  h.update({ events: [next], body: 'sun', cursorUtc: next.utc });
  assert.equal(firstReads, 0, 'the closed drawer does not prepare a superseded list');
  assert.equal(nextReads, 0, 'preparation waits for a visible drawer');
  assert.equal(h.nodes.returnsDate.dateTime, next.utc, 'the independently visible clock stays current');
  h.update({ opened: true });
  assert.equal(firstReads, 0);
  assert.ok(nextReads > 0);
  assert.match(h.nodes.returnsContent.innerHTML, /2028-01-01/);
  assert.doesNotMatch(h.nodes.returnsContent.innerHTML, /2027-01-01/);
  assert.equal(h.nodes.returnsBody.value, 'sun');
  assert.equal(h.layouts, 1);
});

test('moving the footer clock reuses unchanged event rows even when state supplies a new array', () => {
  const h = panelHarness(), value = event('saturn', '2027-01-01T00:00:00Z');
  let bodyReads = 0;
  Object.defineProperty(value, 'body', { get() { bodyReads++; return 'saturn'; } });
  h.update({ timelineVisible: true, opened: true, events: [value] });
  assert.ok(bodyReads > 0);
  bodyReads = 0;
  h.update({ events: [value], cursorUtc: '2026-11-05T12:00:00Z' });
  assert.equal(bodyReads, 0, 'unchanged rows need no new planetary labels');
  assert.equal(h.nodes.returnsDate.dateTime, '2026-11-05T12:00:00Z');
});

test('stable lunar lists reuse parsed event times across repeated clock updates and copied arrays', () => {
  const h = panelHarness();
  const events = Array.from({ length: 1336 }, (_, index) => event('moon', new Date(Date.parse(natal.utc) + (index + 1) * 27.321661 * 86400000).toISOString(), index + 1));
  const eventTimes = new Set(events.map(event => event.utc));
  h.update({ timelineVisible: true, opened: true, group: 'planet', body: 'moon', events });
  const parse = Date.parse; let eventParses = 0;
  Date.parse = value => { if (eventTimes.has(value)) eventParses++; return parse(value); };
  try {
    h.update({ events, cursorUtc: '2026-11-05T12:00:00Z' });
    h.update({ events: [...events], cursorUtc: '2026-11-05T12:01:00Z' });
    assert.equal(eventParses, 0, 'the event dates were already validated and parsed when this list arrived');
  } finally { Date.parse = parse; }
  assert.equal(h.nodes.returnsDate.dateTime, '2026-11-05T12:01:00Z');
});

test('cached first touches keep the exact present boundary and notice appended or replaced events', () => {
  const h = panelHarness(), first = event('moon', '2026-11-05T12:00:00Z'), second = event('moon', '2026-12-05T12:00:00Z', 2);
  const events = [first], now = Date.now;
  let moment = Date.parse(first.utc) - 1;
  Date.now = () => moment;
  try {
    h.update({ timelineVisible: true, opened: true, group: 'year', events });
    const markerIsBefore = id => h.nodes.returnsContent.innerHTML.indexOf('returns-timeline-now') < h.nodes.returnsContent.innerHTML.indexOf(`data-return-event="${id}"`);
    assert.ok(markerIsBefore(first.id));
    moment++; h.update({ events: [...events] }); assert.ok(markerIsBefore(first.id), 'an event exactly now is still at the upcoming boundary');
    moment++; h.update({ events }); assert.equal(markerIsBefore(first.id), false);
    events.push(second); h.update({ events });
    assert.ok(markerIsBefore(second.id));
    const replacement = { ...first, utc: '2027-01-01T12:00:00Z' };
    events[0] = replacement; events.reverse(); h.update({ events });
    assert.ok(markerIsBefore(replacement.id));
    assert.ok(h.nodes.returnsContent.innerHTML.indexOf(second.id) < h.nodes.returnsContent.innerHTML.indexOf(replacement.id));
    assert.match(h.nodes.returnsContent.innerHTML, /datetime="2027-01-01T12:00:00Z"/);
  } finally { Date.now = now; }
});

function panelHarness({ rows = false, pageOwned = true } = {}) {
  const document = dateDom(), ids = ['returnsPanel', 'returnsControls', 'returnsToggle', 'returnsBackdrop', 'returnsContent', 'returnsStatus', 'returnsYear', 'returnsYearCalendar', 'returnsBody', 'returnsClose', 'returnsRetry', 'returnsButtonLabel', 'returnsDate', 'returnsDetail', 'returnsYearField', 'returnsBodyField', 'returnsNote', 'returnsNatalName', 'returnsMomentName'];
  const nodes = Object.fromEntries(ids.map(id => [id, document.createElement('div')]));
  if (rows) {
    const rowDocument = svgDocument();
    const createElement = rowDocument.createElementNS.bind(rowDocument);
    rowDocument.createElementNS = (namespace, tag) => {
      const node = createElement(namespace, tag);
      node.focus = () => { document.activeElement = node; }; node.offsetTop = 0;
      node.closest = selector => { for (let current = node; current; current = current.parentElement) if (current.matches(selector)) return current; return null; };
      return node;
    };
    rowDocument.createElement = tag => rowDocument.createElementNS(SVG_NS, tag);
    const content = rowDocument.createElement('div');
    content.addEventListener = nodes.returnsContent.addEventListener.bind(nodes.returnsContent);
    content.dispatch = nodes.returnsContent.dispatch.bind(nodes.returnsContent);
    nodes.returnsContent = content;
  }
  for (const id of ids) nodes[id].id = id;
  for (const id of ['returnsPanel', 'returnsControls', 'returnsBackdrop']) nodes[id].hidden = true;
  nodes.returnsContent.scrollTop = 0; nodes.returnsContent.clientHeight = 200;
  if (!rows) nodes.returnsContent.querySelector = () => null;
  nodes.returnsPanel.querySelector = () => null;
  document.getElementById = id => nodes[id];
  document.defaultView.matchMedia = () => ({ matches: true, addEventListener() {} });
  let current = { available: true, opened: false, natal, events: [], errors: [], pendingBodies: [], group: 'major', year: 2026, body: 'saturn' }, layouts = 0, view;
  const selected = [], years = [], moments = [];
  const clock = { footer: nodes.returnsControls, entry: nodes.returnsToggle, date: nodes.returnsDate, detail: nodes.returnsDetail, label: nodes.returnsButtonLabel };
  const update = next => { current = { ...current, ...next }; if (pageOwned) updateReturnClock(clock, current); view.update(current); };
  if (pageOwned) nodes.returnsToggle.addEventListener('click', () => update({ opened: !current.opened }));
  view = attachReturnsPanel({ document, onClose: () => update({ opened: false }),
    onGroup() {}, onYear(value) { years.push(value); update({ year: value }); }, onBody() {}, onSelect(id) { selected.push(id); },
    onBirth() { moments.push('birth'); }, onNow() { moments.push('now'); }, onRetry() {}, onLayout: () => layouts++ });
  return { document, nodes, update, selected, years, moments, get layouts() { return layouts; } };
}

test('a loaded return panel does not bind or render its independently available footer', () => {
  const h = panelHarness({ pageOwned: false });
  h.nodes.returnsControls.hidden = false;
  h.nodes.returnsDate.textContent = 'Clock owned by the page';
  h.update({ timelineVisible: true, opened: false });
  h.nodes.returnsToggle.dispatch('click');
  assert.equal(h.nodes.returnsPanel.hidden, true, 'only the page owner toggles the lower entry');
  h.update({ timelineVisible: false });
  assert.equal(h.nodes.returnsControls.hidden, false);
  assert.equal(h.nodes.returnsDate.textContent, 'Clock owned by the page');
});

test('selecting a lunar return preserves all 1336 rows and changes only the old and new event state', () => {
  const h = panelHarness({ rows: true });
  let bodyReads = 0;
  const events = Array.from({ length: 1336 }, (_, index) => {
    const value = event('moon', new Date(Date.parse(natal.utc) + (index + 1) * 27.321661 * 86400000).toISOString(), index + 1);
    Object.defineProperty(value, 'body', { get() { bodyReads++; return 'moon'; } });
    return value;
  });
  h.update({ timelineVisible: true, opened: true, group: 'planet', body: 'moon', events });
  const content = h.nodes.returnsContent, rows = content.querySelectorAll('[data-return-event]');
  let untouchedWrites = 0;
  const setAttribute = rows[300].setAttribute.bind(rows[300]);
  rows[300].setAttribute = (...args) => { untouchedWrites++; setAttribute(...args); };
  content.scrollTop = 750; bodyReads = 0;
  h.document.activeElement = rows[15];
  h.update({ events: [...events], pendingEvent: events[15] });
  assert.ok(content.querySelectorAll('[data-return-event]')[15] === rows[15], 'the pressed row remains the same focused node while loading');
  assert.equal(rows[15].disabled, true); assert.equal(rows[15].querySelector('small').textContent, 'Открываем…');
  const firstStatus = rows[15].querySelector('small');
  h.update({ pendingEvent: null, selectedEvent: events[15] });
  assert.equal(rows[15].disabled, false); assert.equal(rows[15].getAttribute('aria-pressed'), 'true');
  assert.equal(rows[15].querySelector('small').textContent, 'На карте');
  assert.ok(rows[15].querySelector('small') === firstStatus);
  h.update({ pendingEvent: events[16] });
  assert.equal(rows[15].querySelector('small').textContent, 'На карте');
  assert.equal(rows[16].querySelector('small').textContent, 'Открываем…');
  h.update({ pendingEvent: null, selectedEvent: events[16] });
  assert.equal(rows[15].querySelector('small'), null); assert.equal(rows[15].classList.contains('is-selected'), false);
  assert.equal(rows[15].getAttribute('aria-pressed'), 'false'); assert.equal(rows[16].getAttribute('aria-pressed'), 'true');
  h.update({ pendingEvent: events[15] });
  assert.ok(rows[15].querySelector('small') === firstStatus, 'returning to a row reuses its status node');
  h.update({ pendingEvent: null });
  assert.equal(rows[15].querySelector('small'), null); assert.equal(rows[15].disabled, false);
  h.update({ selectedEvent: null });
  assert.equal(rows[16].querySelector('small'), null); assert.equal(rows[16].classList.contains('is-selected'), false);
  const currentRows = content.querySelectorAll('[data-return-event]');
  assert.ok(rows.every((row, index) => row === currentRows[index]));
  assert.equal(content.innerHTMLWrites, 1); assert.equal(bodyReads, 0, 'selection never reformats static dates or planetary labels');
  assert.equal(untouchedWrites, 0);
  assert.equal(content.scrollTop, 750); assert.ok(h.document.activeElement === rows[15]);
});

test('event-state references follow a changed list and apply deferred selection on reopening', () => {
  const h = panelHarness({ rows: true }), first = event('saturn', '2027-01-01T00:00:00Z'), second = event('saturn', '2056-01-01T00:00:00Z', 2);
  h.update({ timelineVisible: true, opened: true, events: [first], selectedEvent: first });
  h.update({ events: [first, second] });
  const rows = h.nodes.returnsContent.querySelectorAll('[data-return-event]');
  h.update({ opened: false, selectedEvent: second });
  assert.equal(rows[0].getAttribute('aria-pressed'), 'true', 'closed drawer defers presentation work');
  h.update({ opened: true });
  assert.ok(h.nodes.returnsContent.querySelectorAll('[data-return-event]')[1] === rows[1]);
  assert.equal(rows[0].getAttribute('aria-pressed'), 'false'); assert.equal(rows[1].getAttribute('aria-pressed'), 'true');
  assert.equal(rows[1].querySelector('small').textContent, 'На карте');
});

test('year entry accepts a complete supported year by Enter and rejects partial or out-of-range drafts', () => {
  const h = panelHarness(); h.update({ timelineVisible: true, opened: true, group: 'year', minYear: 1996, maxYear: 2096 });
  for (const value of ['', '20', '1995', '2097', '2026.5']) {
    h.nodes.returnsYear.value = value; h.nodes.returnsYear.dispatch('change');
    assert.deepEqual(h.years, []);
    assert.equal(h.nodes.returnsYear.getAttribute('aria-invalid'), 'true');
  }
  h.nodes.returnsYear.value = '2031'; h.nodes.returnsYear.dispatch('keydown', { key: 'Enter' });
  assert.deepEqual(h.years, [2031]);
  assert.equal(h.nodes.returnsYear.getAttribute('aria-invalid'), 'false');
  h.nodes.returnsYear.dispatch('change'); assert.deepEqual(h.years, [2031], 'leaving the submitted year does not duplicate the request');
});

test('Returns uses the existing year calendar beside manual entry and closes it when its field is hidden', () => {
  const h = panelHarness(); h.update({ timelineVisible: true, opened: true, group: 'year', minYear: 1996, maxYear: 2096 });
  const popup = h.document.body.children.find(node => node.className === 'date-picker');
  assert.ok(popup, 'the shared calendar is attached');
  h.nodes.returnsYearCalendar.dispatch('click');
  assert.equal(popup.hidden, false); assert.equal(h.document.activeElement.textContent, '2026');
  popup.all(node => node.tagName === 'button').find(node => node.textContent === '2028').dispatch('click');
  assert.deepEqual(h.years, [2028]); assert.equal(h.nodes.returnsYear.value, '2028'); assert.equal(popup.hidden, true);
  h.nodes.returnsYearCalendar.dispatch('click'); h.update({ group: 'planet' });
  assert.equal(popup.hidden, true); assert.equal(h.nodes.returnsYearCalendar.disabled, true);
  h.update({ group: 'year' }); h.nodes.returnsYearCalendar.dispatch('click'); h.update({ opened: false });
  assert.equal(popup.hidden, true); assert.deepEqual(h.years, [2028]);
  assert.equal(h.document.body.children.filter(node => node.className === 'date-picker').length, 1);
});

test('return footer and drawer require an explicit visible Years owner', () => {
  const h = panelHarness(); h.update({ opened: true });
  assert.equal(h.nodes.returnsControls.hidden, true);
  assert.equal(h.nodes.returnsPanel.hidden, true); assert.equal(h.nodes.returnsPanel.inert, true);
  assert.equal(h.nodes.returnsBackdrop.hidden, true); assert.equal(h.nodes.returnsToggle.getAttribute('aria-expanded'), 'false');
  assert.equal(h.layouts, 0, 'an opened state without a visible drawer cannot move the studio');
});

test('closing only the return drawer keeps the Years footer and reopens the same selected exact event', () => {
  const h = panelHarness(), selectedEvent = event('saturn', '2076-10-03T22:30:00Z');
  h.update({ timelineVisible: true, selectedEvent });
  assert.equal(h.nodes.returnsControls.hidden, false); assert.equal(h.nodes.returnsPanel.hidden, true);
  h.nodes.returnsToggle.dispatch('click');
  assert.equal(h.nodes.returnsPanel.hidden, false); assert.equal(h.nodes.returnsBackdrop.hidden, false);
  h.nodes.returnsClose.dispatch('click');
  assert.equal(h.nodes.returnsControls.hidden, false); assert.equal(h.nodes.returnsPanel.hidden, true);
  h.nodes.returnsToggle.dispatch('click');
  assert.equal(h.nodes.returnsPanel.hidden, false); assert.equal(h.nodes.returnsDate.dateTime, selectedEvent.utc);
  assert.equal(h.nodes.returnsDate.textContent, '4 октября 2076'); assert.equal(h.nodes.returnsButtonLabel.textContent, 'Возвраты');
  assert.equal(h.layouts, 3); assert.equal(h.document.activeElement, h.nodes.returnsClose);
});

test('hiding Years while its return drawer is open hides both views and backdrop, requests layout and releases Escape', () => {
  const h = panelHarness(); h.update({ timelineVisible: true, opened: true });
  assert.equal(h.layouts, 1); assert.equal(h.nodes.returnsPanel.hidden, false);
  h.update({ timelineVisible: false });
  assert.equal(h.nodes.returnsControls.hidden, true); assert.equal(h.nodes.returnsPanel.hidden, true);
  assert.equal(h.nodes.returnsPanel.inert, true); assert.equal(h.nodes.returnsPanel.getAttribute('aria-hidden'), 'true');
  assert.equal(h.nodes.returnsPanel.getAttribute('aria-modal'), 'false'); assert.equal(h.nodes.returnsBackdrop.hidden, true);
  assert.equal(h.layouts, 2, 'owner visibility closes the real drawer without needing opened to change first');
  const otherControl = h.document.createElement('input'); otherControl.focus();
  h.document.dispatch('keydown', { key: 'Escape' }); assert.equal(h.document.activeElement, otherControl);
  h.update({ timelineVisible: true, opened: false }); h.nodes.returnsToggle.dispatch('click');
  assert.equal(h.nodes.returnsControls.hidden, false); assert.equal(h.nodes.returnsPanel.hidden, false); assert.equal(h.layouts, 3);
});


test('first touches retain cycle ordinals and never treat a later pass as another cycle', () => {
  const passes = [event('north_node', '2033-01-01T00:00:00Z', 2, 1), event('north_node', '2033-02-01T00:00:00Z', 2, 2), event('north_node', '2033-03-01T00:00:00Z', 2, 3)];
  const markup = renderReturnEvents({ natal, events: [...passes, event('saturn', '2056-01-01T00:00:00Z', 2, 1)] }, Date.parse('2026-01-01T00:00:00Z'));
  assert.equal((markup.match(/Возврат лунных узлов 2/g) || []).length, 1);
  assert.doesNotMatch(markup, /Возврат лунных узлов 1|Возврат лунных узлов 3/); assert.match(markup, /Возврат Сатурна 2/);
  assert.equal((markup.match(/data-return-event=/g) || []).length, 2); assert.doesNotMatch(markup, /Проход 3/);
});
test('drawer timeline places first touches chronologically around the present despite interleaved later passes', () => {
  const first = event('saturn', '2026-01-01T00:00:00Z', 1, 1), middle = event('north_node', '2026-02-01T00:00:00Z', 2, 1), last = event('saturn', '2026-03-01T00:00:00Z', 1, 2);
  const future = event('chiron', '2026-04-01T00:00:00Z', 1, 1);
  const markup = renderReturnEvents({ natal, events: [last, future, first, middle], selectedEvent: last }, Date.parse('2026-02-15T00:00:00Z'));
  assert.match(markup, /class="returns-timeline"/); assert.match(markup, /class="returns-timeline-dot" aria-hidden="true"/);
  assert.deepEqual([...markup.matchAll(/data-return-event="([^"]+)"/g)].map(match => match[1]), [first.id, middle.id, future.id]);
  assert.ok(markup.indexOf(middle.id) < markup.indexOf('Сейчас')); assert.ok(markup.indexOf('Сейчас') < markup.indexOf(future.id));
});
test('the present marker follows a past first touch without exposing the same cycle future pass', () => {
  const first = event('saturn', '2026-01-01T00:00:00Z', 1, 1), last = event('saturn', '2026-03-01T00:00:00Z', 1, 2);
  const markup = renderReturnEvents({ natal, events: [last, first] }, Date.parse('2026-02-01T00:00:00Z'));
  assert.ok(markup.indexOf(first.id) < markup.indexOf('Сейчас')); assert.ok(!markup.includes(last.id));
  assert.equal((markup.match(/returns-timeline-item returns-timeline-now/g) || []).length, 1);
});
test('Returns entry label stays stable through loading, event selection and reset', () => {
  const h = panelHarness();
  for (const state of [{ timelineVisible: true }, { opened: true, loadingChart: true, pendingEvent: event('saturn', '2026-01-01T00:00:00Z', 1, 3) },
    { loadingChart: false, selectedEvent: event('north_node', '2033-01-01T00:00:00Z', 2, 1) }, { selectedEvent: null }]) {
    h.update(state); assert.equal(h.nodes.returnsButtonLabel.textContent, 'Возвраты');
  }
});


test('planet browsing preserves the full body chooser and exposes no misleading annual field', () => {
  const h = panelHarness(); h.update({ timelineVisible: true, opened: true, group: 'planet', body: 'sun' });
  assert.equal(h.nodes.returnsBodyField.hidden, false);
  assert.equal(h.nodes.returnsYearField.hidden, true);
  assert.match(h.nodes.returnsBody.innerHTML, /value="sun"/); assert.match(h.nodes.returnsBody.innerHTML, /value="moon"/);
  h.update({ group: 'year' }); assert.equal(h.nodes.returnsYearField.hidden, false); assert.equal(h.nodes.returnsBodyField.hidden, true);
  h.update({ group: 'major' }); assert.equal(h.nodes.returnsYearField.hidden, true); assert.equal(h.nodes.returnsBodyField.hidden, true);
});

test('opening and changing a planet anchors once near the present after dates arrive without resetting later reading', () => {
  const h = panelHarness(), marker = { offsetTop: 600 };
  h.nodes.returnsContent.querySelector = selector => selector === '.returns-timeline-now' ? marker : null;
  h.update({ timelineVisible: true, opened: true, group: 'planet', body: 'north_node', pendingBodies: ['north_node'] });
  assert.equal(h.nodes.returnsContent.scrollTop, 0, 'wait for the list rather than jumping during loading');
  h.update({ events: [event('north_node', '2033-01-01T00:00:00Z', 2)], pendingBodies: [] });
  assert.equal(h.nodes.returnsContent.scrollTop, 540);
  h.nodes.returnsContent.scrollTop = 120; h.update({ loadingChart: true });
  assert.equal(h.nodes.returnsContent.scrollTop, 120, 'unrelated chart updates preserve manual list position');
  h.update({ body: 'sun', pendingBodies: ['sun'] }); assert.equal(h.nodes.returnsContent.scrollTop, 120);
  h.update({ pendingBodies: [], events: [event('sun', '2027-01-01T00:00:00Z')] }); assert.equal(h.nodes.returnsContent.scrollTop, 540);
});


test('birth is the first full-row action without a separate reset button', () => {
  const h = panelHarness(), first = event('jupiter', '2008-10-01T00:00:00Z');
  h.update({ timelineVisible: true, opened: true, events: [first], canReset: true });
  const document = svgDocument(), list = document.createElementNS(SVG_NS, 'g');
  list.innerHTML = h.nodes.returnsContent.innerHTML;
  const birth = list.querySelector('[data-return-birth]');
  assert.ok(birth); assert.equal(birth.tagName, 'button'); assert.equal(birth.getAttribute('type'), 'button');
  assert.equal(birth.querySelectorAll('button').length, 0);
  assert.equal(birth.querySelector('strong').textContent, 'Рождение');
  assert.equal(birth.querySelector('time').getAttribute('datetime'), natal.utc);
  assert.ok(h.nodes.returnsContent.innerHTML.indexOf('Рождение') < h.nodes.returnsContent.innerHTML.indexOf(first.id));
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.doesNotMatch(html, /returnsReset|К личной карте/);
});

test('Birth and Now dispatch their existing rows from nested content without selecting an event', () => {
  const h = panelHarness({ rows: true }), first = event('jupiter', '2008-10-01T00:00:00Z');
  h.update({ timelineVisible: true, opened: true, events: [first] });
  const content = h.nodes.returnsContent, birth = content.querySelector('[data-return-birth]'), now = content.querySelector('[data-return-now]');
  assert.ok(now); assert.equal(now.tagName, 'button'); assert.equal(now.getAttribute('type'), 'button');
  assert.equal(now.classList.contains('returns-event'), true); assert.equal(now.querySelectorAll('button').length, 0);
  content.dispatch('click', { target: birth.querySelector('strong') });
  content.dispatch('click', { target: now.querySelector('span') });
  assert.deepEqual(h.moments, ['birth', 'now']); assert.deepEqual(h.selected, []);
  content.dispatch('click', { target: content.querySelector('[data-return-event]').querySelector('time') });
  assert.deepEqual(h.selected, [first.id]);
});

test('Birth and explicit live selection preserve all lunar rows and never infer Now from matching UTC', () => {
  const h = panelHarness({ rows: true });
  const events = Array.from({ length: 1336 }, (_, i) => event('moon', new Date(Date.parse(natal.utc) + (i + 1) * 27 * 86400000).toISOString(), i + 1));
  h.update({ timelineVisible: true, opened: true, group: 'planet', body: 'moon', events, birthSelected: true, live: false, cursorUtc: natal.utc });
  const content = h.nodes.returnsContent, birth = content.querySelector('[data-return-birth]'), now = content.querySelector('[data-return-now]');
  const rows = content.querySelectorAll('[data-return-event]');
  assert.equal(birth.getAttribute('aria-pressed'), 'true'); assert.equal(now.getAttribute('aria-pressed'), 'false');
  content.scrollTop = 18000; birth.focus();
  const utc = new Date().toISOString();
  h.update({ birthSelected: false, live: true, cursorUtc: utc });
  assert.equal(birth.getAttribute('aria-pressed'), 'false'); assert.equal(now.getAttribute('aria-pressed'), 'true');
  assert.equal(now.classList.contains('is-selected'), true);
  h.update({ live: false, cursorUtc: utc });
  assert.equal(now.getAttribute('aria-pressed'), 'false', 'a manually selected moment at the same UTC is not live');
  h.update({ cursorUtc: natal.utc, birthSelected: false });
  assert.equal(birth.getAttribute('aria-pressed'), 'false', 'a sampled birth slot is not the original birth owner');
  h.update({ selectedEvent: events[10] });
  assert.equal(rows[10].getAttribute('aria-pressed'), 'true');
  h.update({ selectedEvent: null, birthSelected: true });
  assert.equal(rows[10].getAttribute('aria-pressed'), 'false'); assert.equal(birth.getAttribute('aria-pressed'), 'true');
  const retainedRows = content.querySelectorAll('[data-return-event]');
  assert.ok(rows.every((row, index) => row === retainedRows[index]));
  assert.equal(content.querySelector('[data-return-birth]'), birth); assert.equal(content.querySelector('[data-return-now]'), now);
  assert.equal(content.innerHTMLWrites, 1); assert.equal(content.scrollTop, 18000); assert.equal(h.document.activeElement, birth);
});
test('birth remains visible while the first returns are loading and does not enter a year-only list', () => {
  const h = panelHarness();
  h.update({ timelineVisible: true, opened: true, pendingBodies: ['saturn'], events: [] });
  assert.match(h.nodes.returnsContent.innerHTML, /data-return-birth/);
  h.update({ group: 'year', pendingBodies: [], events: [] });
  assert.doesNotMatch(h.nodes.returnsContent.innerHTML, /data-return-birth/);
});

test('a full century of lunar rows stays chronological and selectable while later updates preserve list reading', () => {
  const events = Array.from({ length: 1336 }, (_, i) => event('moon', new Date(Date.parse(natal.utc) + i * 27 * 86400000).toISOString(), i + 1));
  const h = panelHarness(); h.update({ timelineVisible: true, opened: true, group: 'planet', body: 'moon', events: [...events].reverse() });
  const document = svgDocument(), list = document.createElementNS(SVG_NS, 'g'); list.innerHTML = h.nodes.returnsContent.innerHTML;
  const buttons = list.querySelectorAll('[data-return-event]');
  assert.equal(buttons.length, 1336, 'the UI never truncates older or future returns');
  assert.equal(buttons[0].dataset.returnEvent, events[0].id); assert.equal(buttons.at(-1).dataset.returnEvent, events.at(-1).id);
  assert.equal(list.querySelectorAll('.returns-timeline-now').length, 1);
  h.nodes.returnsContent.dispatch('click', { target: { closest: () => buttons.at(-1) } });
  assert.deepEqual(h.selected, [events.at(-1).id]);
  h.nodes.returnsContent.scrollTop = 18000; h.update({ selectedEvent: events.at(-1) });
  assert.equal(h.nodes.returnsContent.scrollTop, 18000);
});

test('the shipped panel begins with dates and keeps compact filters after the list without a natal name header', () => {
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const markup = html.match(/<aside class="returns-panel"[\s\S]*?<\/aside>/)[0];
  const document = svgDocument(), panel = document.createElementNS(SVG_NS, 'g'); panel.innerHTML = markup.replace(/<input([^>]*?)>/g, '<input$1/>');
  assert.ok(panel.querySelector('.returns-overlay-key [id="returnsNatalName"]'), 'the name belongs to the existing color legend');
  const aside = panel.firstElementChild;
  const contentIndex = aside.children.findIndex(node => node.getAttribute('id') === 'returnsContent');
  const controlsIndex = aside.children.findIndex(node => node.getAttribute('class') === 'returns-panel-controls');
  assert.ok(contentIndex < controlsIndex);
  assert.equal(panel.querySelectorAll('[data-returns-group]').length, 3);
  assert.equal(panel.querySelector('[id="returnsNow"]'), null); assert.ok(panel.querySelector('[id="returnsBody"]'));
  const controls = panel.querySelector('.returns-panel-controls');
  assert.ok(controls.children.findIndex(node => node.classList.contains('returns-filters'))
    < controls.children.findIndex(node => node.classList.contains('returns-control-bar')));
  assert.ok(panel.querySelector('[id="returnsYearCalendar"]'));
});


test('an open phone return sheet remains nonmodal so native navigation and the personal strip stay accessible', () => {
  const h = panelHarness(); h.update({ timelineVisible: true, opened: true });
  assert.equal(h.nodes.returnsPanel.getAttribute('role'), 'dialog');
  assert.equal(h.nodes.returnsPanel.getAttribute('aria-modal'), 'false');
  assert.equal(h.nodes.returnsPanel.inert, false);
  assert.equal(h.nodes.returnsControls.hidden, false);
  assert.equal(h.nodes.returnsControls.inert, undefined, 'the persistent footer is not made inert with the open sheet');
  assert.equal(h.nodes.returnsToggle.getAttribute('aria-expanded'), 'true');
  assert.equal(h.nodes.returnsBackdrop.hidden, false, 'outside dismissal remains available without claiming modal ownership');
});


test('the return drawer legend follows the visible transit overlay while keeping its return navigation title', () => {
  const h = panelHarness(); h.update({ timelineVisible: true, opened: true, overlayKind: 'transit' });
  assert.equal(h.nodes.returnsMomentName.textContent, 'Транзит');
  assert.equal(h.nodes.returnsButtonLabel.textContent, 'Возвраты');
  h.update({ overlayKind: 'return' }); assert.equal(h.nodes.returnsMomentName.textContent, 'Возврат');
});

test('the overlay legend shows the saved chart name as text and refreshes a rename without rebuilding return rows', () => {
  const h = panelHarness({ rows: true }), value = event('saturn', '2027-01-01T00:00:00Z');
  h.update({ timelineVisible: true, opened: true, events: [value], natal: { ...natal, name: 'Марат <b> & "друг"' } });
  const row = h.nodes.returnsContent.querySelector('[data-return-event]');
  assert.equal(h.nodes.returnsNatalName.textContent, 'Марат <b> & "друг"');
  assert.equal(h.nodes.returnsNatalName.title, 'Марат <b> & "друг"');
  h.update({ natal: { ...natal, name: 'Анна' } });
  assert.equal(h.nodes.returnsNatalName.textContent, 'Анна');
  assert.equal(h.nodes.returnsContent.querySelector('[data-return-event]'), row);
  h.update({ natal: { ...natal, name: '' } });
  assert.equal(h.nodes.returnsNatalName.textContent, 'Личная карта');
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(html, /id="returnsNatalName"/); assert.match(html, /id="returnsMomentName"/);
  assert.doesNotMatch(html, />Натал</);
});
