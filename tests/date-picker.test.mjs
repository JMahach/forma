import test from 'node:test';
import assert from 'node:assert/strict';
import { attachDatePicker } from '../src/views/date-picker.js';
import { dateDom } from './helpers/date-dom.mjs';
import { createViewportLayout } from './helpers/viewport-layout.mjs';
function harness(value = '15.08.2025', bounds = { min: '1801-01-01', max: '2399-12-31' }, options = {}) {
  const document = dateDom(), input = document.createElement('input'), button = document.createElement('button');
  document.defaultView.visualViewport = Object.assign(new EventTarget(), { offsetLeft: 0, offsetTop: 0, width: 320, height: 800 });
  const viewportLayout = options.viewportLayout || createViewportLayout(document);
  input.id = 'date'; input.value = value; input.setAttribute('aria-label', 'Дата'); document.body.append(input, button);
  const selected = [], picker = attachDatePicker({ input, button, getBounds: () => bounds, onSelect: value => selected.push(value), viewportLayout, ...options });
  const popup = document.body.children.at(-1);
  const buttons = () => popup.all(node => node.tagName === 'button');
  const click = text => { const target = buttons().find(node => node.textContent === text && !node.hidden); assert.ok(target, text); target.dispatch('click'); };
  return { document, input, button, popup, picker, selected, buttons, click, viewportLayout };
}
test('an optional presentation shares a header without duplicating close or changing year selection', () => {
  const h = harness('2026', { min: '1996-01-01', max: '2096-12-31' }, {
    precision: 'year', clearLabel: 'Вся жизнь', onClear() {},
    presentation: { className: 'returns-filter-popover', title: 'Период' },
  });
  h.button.dispatch('click');
  assert.ok(h.popup.className.split(' ').includes('returns-filter-popover'));
  const header = h.popup.children[0];
  assert.equal(header.className, 'returns-menu-heading');
  assert.equal(header.children[0].textContent, 'Период');
  assert.equal(h.buttons().filter(button => button.textContent === '×').length, 1);
  assert.ok(h.popup.children.at(-1).className.split(' ').includes('returns-menu-actions'));
  h.click('2027');
  assert.deepEqual(h.selected, ['2027-01-01']);
  assert.equal(h.document.activeElement, h.button);
  h.button.dispatch('click'); h.click('×');
  assert.equal(h.popup.hidden, true); assert.equal(h.document.activeElement, h.button);
  h.button.dispatch('click'); h.popup.dispatch('keydown', { key: 'Escape' });
  assert.equal(h.popup.hidden, true); assert.equal(h.document.activeElement, h.button);
  h.button.dispatch('click');
  h.popup.children[0].children.at(-1).focus();
  h.popup.dispatch('keydown', { key: 'Tab', shiftKey: true });
  assert.equal(h.popup.hidden, true, 'backward Tab exits from the first header control');
});

test('optional placement stays below its trigger within panel and visual viewport bounds', () => {
  let area = { left: 30, top: 120, right: 310, bottom: 680 };
  const h = harness('2026', { min: '1996-01-01', max: '2096-12-31' }, {
    precision: 'year', presentation: { getBounds: () => area, preferBelow: true },
  });
  h.button.getBoundingClientRect = () => ({ left: 35, top: 180, bottom: 212 });
  h.popup.getBoundingClientRect = () => ({ width: Math.min(240, Number.parseFloat(h.popup.style.maxWidth)),
    height: Math.min(280, Number.parseFloat(h.popup.style.maxHeight)) });
  h.button.dispatch('click');
  assert.equal(h.popup.style.left, '30px'); assert.equal(h.popup.style.top, '220px');
  assert.equal(h.popup.style.maxWidth, '280px'); assert.equal(h.popup.style.maxHeight, '560px');
  // A reduced visual viewport models the available area above a phone keyboard.
  Object.assign(h.document.defaultView.visualViewport, { offsetLeft: 20, offsetTop: 100, width: 240, height: 300 });
  area = { ...area, top: 150 };
  h.document.defaultView.dispatch('resize');
  assert.equal(h.popup.style.left, '30px'); assert.equal(h.popup.style.top, '150px');
  assert.equal(h.popup.style.maxWidth, '222px'); assert.equal(h.popup.style.maxHeight, '242px');
  h.popup.dispatch('keydown', { key: 'Escape' });
  assert.equal(h.document.activeElement, h.button);
});
test('year precision opens at the typed year and selects it without a month or day step', () => {
  const h = harness('2026', { min: '1996-01-01', max: '2096-12-31' }, { precision: 'year' });
  h.button.dispatch('click');
  assert.equal(h.document.activeElement.textContent, '2026');
  assert.equal(h.document.activeElement.dataset.selected, 'true');
  h.click('2027');
  assert.equal(h.popup.hidden, true);
  assert.deepEqual(h.selected, ['2027-01-01']);
  assert.equal(h.popup.dataset.view, 'years');
  assert.equal(h.document.activeElement, h.button);
});
test('an optional all-years action clears the filter and returns focus without selecting a date', () => {
  let cleared = 0;
  const h = harness('2026', { min: '1996-01-01', max: '2096-12-31' },
    { precision: 'year', clearLabel: 'Все годы', onClear: () => cleared++ });
  h.button.dispatch('click'); h.click('Все годы');
  assert.equal(cleared, 1); assert.deepEqual(h.selected, []);
  assert.equal(h.popup.hidden, true); assert.equal(h.document.activeElement, h.button);
});
test('year precision keeps period navigation and cancel without inventing a year', () => {
  const h = harness('', { min: '1996-01-01', max: '2096-12-31' }, { precision: 'year' });
  h.button.dispatch('click'); h.click('1996–2006'); h.click('2085–2096'); h.click('2095');
  assert.deepEqual(h.selected, ['2095-01-01']);
  h.button.dispatch('click'); h.popup.dispatch('keydown', { key: 'Escape' });
  assert.deepEqual(h.selected, ['2095-01-01']);
});
test('same-year drill-down keeps the actual October 4 selection and commits only the final day', () => {
  const h = harness('04.10.2026'); h.button.dispatch('click');
  assert.equal(h.popup.dataset.view, 'years'); assert.equal(h.button.getAttribute('aria-expanded'), 'true');
  assert.equal(h.document.activeElement.textContent, '2026');
  h.click('2026');
  assert.deepEqual(h.selected, []); assert.equal(h.popup.dataset.view, 'months');
  assert.equal(h.document.activeElement.textContent, 'Октябрь');
  assert.equal(h.document.activeElement.dataset.selected, 'true');
  h.click('Октябрь'); assert.deepEqual(h.selected, []); assert.equal(h.popup.dataset.view, 'days');
  assert.equal(h.document.activeElement.textContent, '4');
  assert.equal(h.document.activeElement.dataset.selected, 'true');
  h.click('12'); assert.deepEqual(h.selected, ['2026-10-12']); assert.equal(h.popup.hidden, true);
  assert.equal(h.document.activeElement, h.button);
});
test('dismissing a chosen year commits January 1 exactly once across close paths', () => {
  for (const dismiss of [h => h.document.dispatch('pointerdown', { target: h.input }), h => h.input.focus(),
    h => h.popup.dispatch('keydown', { key: 'Tab' }),
    h => h.button.dispatch('click'), h => h.picker.close()]) {
    const h = harness('04.10.2026'); h.button.dispatch('click'); h.click('2027');
    assert.deepEqual(h.selected, []); dismiss(h);
    assert.equal(h.popup.hidden, true); assert.deepEqual(h.selected, ['2027-01-01']);
    h.picker.close(); assert.deepEqual(h.selected, ['2027-01-01']);
  }
});
test('dismissing a chosen month commits its first day and a new session has no pending choice', () => {
  const h = harness('04.10.2026'); h.button.dispatch('click'); h.click('2027'); h.click('Октябрь');
  assert.deepEqual(h.selected, []); h.document.dispatch('pointerdown', { target: h.input }); assert.deepEqual(h.selected, ['2027-10-01']);
  h.button.dispatch('click'); h.click('×'); assert.deepEqual(h.selected, ['2027-10-01']);
});
test('preserved day clamps at leap-year and shorter-month boundaries without intermediate commits', () => {
  const leap = harness('29.02.2024'); leap.button.dispatch('click'); leap.click('2025'); leap.click('Февраль');
  assert.equal(leap.document.activeElement.textContent, '28');
  assert.equal(leap.document.activeElement.dataset.selected, undefined); assert.deepEqual(leap.selected, []);
  leap.click('28'); assert.deepEqual(leap.selected, ['2025-02-28']);
  const shorter = harness('31.10.2026'); shorter.button.dispatch('click'); shorter.click('2026'); shorter.click('Ноябрь');
  assert.equal(shorter.document.activeElement.textContent, '30'); assert.deepEqual(shorter.selected, []);
});
test('partial boundary years and months remain selectable and coarse commits stay within bounds', () => {
  const bounds = { min: '2026-10-04', max: '2027-02-10' };
  const h = harness('04.10.2026', bounds); h.button.dispatch('click');
  assert.equal(h.buttons().find(button => button.textContent === '2026').disabled, false);
  h.click('2026'); assert.equal(h.buttons().find(button => button.textContent === 'Сентябрь').disabled, true);
  assert.equal(h.buttons().find(button => button.textContent === 'Октябрь').disabled, false);
  h.click('Октябрь'); assert.equal(h.buttons().find(button => button.textContent === '3').disabled, true);
  h.document.dispatch('pointerdown', { target: h.input }); assert.deepEqual(h.selected, ['2026-10-04']);
  const upper = harness('31.10.2026', bounds); upper.button.dispatch('click'); upper.click('2027');
  assert.equal(upper.document.activeElement.textContent, 'Февраль'); upper.click('Февраль');
  assert.equal(upper.document.activeElement.textContent, '10');
  assert.equal(upper.buttons().find(button => button.textContent === '11').disabled, true);
  upper.click('10'); assert.deepEqual(upper.selected, ['2027-02-10']);
});
test('period grid reaches both supported endpoints and leap/century day boundaries are exact', () => {
  const h = harness('01.01.1801'); h.button.dispatch('click'); h.click('1801–1825');
  assert.equal(h.popup.dataset.view, 'periods');
  h.click('2376–2399'); h.click('2399'); h.click('Декабрь'); h.click('31');
  assert.equal(h.selected.at(-1), '2399-12-31');
  for (const [year, last] of [[1900, 28], [2000, 29], [2100, 28], [2024, 29]]) {
    const leap = harness(`01.01.${year}`); leap.button.dispatch('click'); leap.click(String(year)); leap.click('Февраль');
    const days = leap.buttons().filter(node => /^\d+$/.test(node.textContent));
    assert.equal(days.at(-1).textContent, String(last));
  }
});
test('arrows/Home/End/PageDown navigate the grid; Escape returns focus and leaves typed value unchanged', () => {
  const h = harness('01.01.2026'); h.button.dispatch('click');
  const key = value => h.popup.dispatch('keydown', { key: value });
  key('ArrowRight'); assert.equal(h.document.activeElement.textContent, '2027');
  key('ArrowDown'); assert.equal(h.document.activeElement.textContent, '2032');
  key('Home'); assert.equal(h.document.activeElement.textContent, '2031');
  key('End'); assert.equal(h.document.activeElement.textContent, '2035');
  key('PageDown'); assert.equal(h.document.activeElement.textContent, '2051');
  key('Escape'); assert.equal(h.picker.opened, false); assert.equal(h.document.activeElement, h.button);
  assert.equal(h.input.value, '01.01.2026'); assert.deepEqual(h.selected, []);
});
test('outside pointer, focus departure and repeated opens clean up popup subscriptions without replacing the viewport owner', () => {
  const h = harness();
  for (let i = 0; i < 5; i++) {
    h.button.dispatch('click'); assert.equal(h.document.listenerCount('pointerdown'), 1);
    h.document.dispatch('pointerdown', { target: h.input }); assert.equal(h.picker.opened, false);
    assert.equal(h.document.listenerCount('pointerdown'), 0);
    assert.equal(h.viewportLayout.subscriberCount, 0);
    assert.equal(h.document.defaultView.listenerCount('resize'), 1, 'one page-lifetime viewport owner survives popup dismissal');
  }
  h.button.dispatch('click'); h.input.focus(); assert.equal(h.picker.opened, false);
  h.viewportLayout.destroy(); assert.equal(h.document.defaultView.listenerCount('resize'), 0);
});
test('popup clamps to the narrow viewport and is positioned above the bottom controls', () => {
  const h = harness(); h.button.dispatch('click');
  assert.equal(h.popup.style.left, '26px'); assert.equal(h.popup.style.top, '422px');
});

test('visual viewport keyboard height limits the scrollable popup before it is positioned', () => {
  const h = harness();
  Object.assign(h.document.defaultView.visualViewport, { width: 320, height: 210, offsetTop: 100, offsetLeft: 0 });
  h.button.dispatch('click');
  assert.equal(h.popup.style.maxHeight, '194px'); assert.equal(h.popup.style.top, '108px');
});

test('day Home/End respects weekday-offset rows, and Tab leaves the portal at its own date input', () => {
  const h = harness('01.01.2026'); h.button.dispatch('click'); h.click('2026'); h.click('Сентябрь');
  const seventh = h.buttons().find(button => button.textContent === '7'); seventh.focus();
  h.popup.dispatch('keydown', { key: 'Home' }); assert.equal(h.document.activeElement.textContent, '7');
  h.popup.dispatch('keydown', { key: 'End' }); assert.equal(h.document.activeElement.textContent, '13');
  h.popup.dispatch('keydown', { key: 'Tab' }); assert.equal(h.picker.opened, false); assert.equal(h.document.activeElement, h.input);
});

// Browsing a copied month/day must not declare it selected or today.
test('future and past years keep the cursor without copying selected or current markers', t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date(2026, 9, 4, 12) });
  for (const year of [2050, 2025]) {
    const h = harness('04.10.2026'); h.button.dispatch('click');
    if (year === 2025) h.click('‹');
    h.click(String(year));
    assert.equal(h.document.activeElement.textContent, 'Октябрь');
    assert.deepEqual(h.buttons().filter(button => button.dataset.selected === 'true').map(button => button.textContent), []);
    assert.deepEqual(h.buttons().filter(button => button.getAttribute('aria-current')).map(button => button.textContent), []);
    h.click('Октябрь'); assert.equal(h.document.activeElement.textContent, '4');
    assert.deepEqual(h.buttons().filter(button => button.dataset.selected === 'true').map(button => button.textContent), []);
    assert.deepEqual(h.buttons().filter(button => button.getAttribute('aria-current')).map(button => button.textContent), []);
    h.click('4'); assert.deepEqual(h.selected, [`${year}-10-04`]);
  }
});
test('today markers belong only to the real local year, month and day', t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date(2026, 9, 4, 12) });
  const h = harness('15.08.2026'); h.button.dispatch('click');
  assert.deepEqual(h.buttons().filter(button => button.getAttribute('aria-current')).map(button => button.textContent), ['2026']);
  h.click('2026');
  assert.deepEqual(h.buttons().filter(button => button.getAttribute('aria-current')).map(button => button.textContent), ['Октябрь']);
  assert.deepEqual(h.buttons().filter(button => button.dataset.selected === 'true').map(button => button.textContent), ['Август']);
  h.click('Октябрь');
  assert.deepEqual(h.buttons().filter(button => button.getAttribute('aria-current')).map(button => button.textContent), ['4']);
  assert.deepEqual(h.buttons().filter(button => button.dataset.selected === 'true').map(button => button.textContent), []);
  h.click('Октябрь 2026'); h.click('Ноябрь');
  assert.deepEqual(h.buttons().filter(button => button.getAttribute('aria-current')).map(button => button.textContent), []);
});
test('empty or invalid input has a browsing fallback but no invented actual selection', () => {
  for (const value of ['', '31.02.2026', 'not a date']) {
    const h = harness(value); h.button.dispatch('click');
    assert.equal(h.document.activeElement.textContent, '1801');
    assert.deepEqual(h.buttons().filter(button => button.dataset.selected === 'true').map(button => button.textContent), []);
    h.click('1801');
    assert.deepEqual(h.buttons().filter(button => button.dataset.selected === 'true').map(button => button.textContent), []);
    h.click('Январь');
    assert.deepEqual(h.buttons().filter(button => button.dataset.selected === 'true').map(button => button.textContent), []);
    h.document.dispatch('pointerdown', { target: h.input }); assert.deepEqual(h.selected, ['1801-01-01']);
  }
});

test('the period chooser title is a heading, while close remains the first keyboard control', () => {
  const h = harness();
  h.button.dispatch('click'); h.click('2001–2025');
  const title = h.popup.all(node => node.textContent === 'Выберите период')[0];
  assert.equal(title.tagName, 'h3');
  title.dispatch('click');
  assert.equal(h.popup.dataset.view, 'periods');
  assert.deepEqual(h.selected, []);
  h.buttons().find(button => button.textContent === '×').focus();
  h.popup.dispatch('keydown', { key: 'Tab', shiftKey: true });
  assert.equal(h.popup.hidden, true);
  assert.equal(h.document.activeElement, h.button);
});


test('close button and Escape discard a browsed year or month and reopen at the accepted date', () => {
  for (const month of [false, true]) for (const cancel of [h => h.click('×'), h => h.popup.dispatch('keydown', { key: 'Escape' })]) {
    const h = harness('04.10.2026');
    h.button.dispatch('click'); h.click('2027');
    if (month) h.click('Май');
    cancel(h);
    assert.deepEqual(h.selected, []);
    assert.equal(h.input.value, '04.10.2026');
    assert.equal(h.popup.hidden, true);
    assert.equal(h.document.activeElement, h.button);
    h.button.dispatch('click');
    assert.equal(h.document.activeElement.textContent, '2026');
    h.document.dispatch('pointerdown', { target: h.input });
    assert.deepEqual(h.selected, [], 'cancelled draft must not leak to the next session');
  }
});

test('calendar follows the layout viewport and updated anchor in the same notification, then unsubscribes', () => {
  const listeners = new Set();
  let viewport = { left: 0, top: 100, width: 320, height: 210 };
  let anchor = { left: 260, top: 270, bottom: 298 };
  const h = harness(undefined, undefined, { viewportLayout: {
    readViewport: () => viewport,
    subscribeViewport: listener => { listeners.add(listener); return () => listeners.delete(listener); },
  } });
  // Safari's raw viewport intentionally stays at the keyboard height throughout.
  h.document.defaultView.visualViewport = { offsetLeft: 0, offsetTop: 100, width: 320, height: 210, addEventListener() {}, removeEventListener() {} };
  h.button.getBoundingClientRect = () => anchor;
  h.button.dispatch('click');
  assert.equal(h.document.defaultView.listenerCount('resize'), 0, 'the layout owner is the only native resize source');
  assert.equal(h.popup.style.maxHeight, '194px');
  viewport = { left: 0, top: 0, width: 320, height: 800 };
  anchor = { left: 260, top: 710, bottom: 738 };
  for (const notify of listeners) notify();
  assert.equal(h.popup.style.maxHeight, '784px');
  assert.equal(h.popup.style.top, '422px');
  h.document.defaultView.dispatch('resize');
  assert.equal(h.popup.style.top, '422px', 'a stale raw viewport must not pull the calendar back up');
  h.click('×'); assert.equal(listeners.size, 0);
  h.button.dispatch('click'); assert.equal(listeners.size, 1);
  h.picker.close(); assert.equal(listeners.size, 0);
});

test('an injected viewport still follows nested scrolling without duplicating page scroll notifications', () => {
  const listeners = new Set();
  const h = harness(undefined, undefined, { viewportLayout: {
    readViewport: () => ({ left: 0, top: 0, width: 320, height: 800 }),
    subscribeViewport: listener => { listeners.add(listener); return () => listeners.delete(listener); },
  } });
  let top = 710, reads = 0;
  h.button.getBoundingClientRect = () => { reads++; return { left: 260, top, bottom: top + 28 }; };
  h.button.dispatch('click'); reads = 0;
  h.document.defaultView.dispatch('scroll', { target: h.document });
  h.document.defaultView.dispatch('scroll');
  assert.equal(reads, 0, 'page scrolling is delivered by the layout owner after dock placement');
  const scroller = h.document.createElement('div'); top = 650;
  h.document.defaultView.dispatch('scroll', { target: scroller });
  assert.equal(reads, 1, 'a nested scroller moves the anchor without changing viewport bounds');
  assert.equal(h.popup.style.top, '362px');
  h.picker.close();
  assert.equal(h.document.defaultView.listenerCount('scroll'), 0);
});


test('nine balanced year periods cover the whole century exactly once', () => {
  const h = harness('2026', { min: '2000-01-01', max: '2100-12-31' }, { precision: 'year' });
  const gridChoices = () => h.popup.all(node => node.getAttribute('role') === 'grid')[0]
    .all(node => node.tagName === 'button');
  h.button.dispatch('click'); h.click('2022–2032');
  const periods = gridChoices().map(button => button.textContent);
  assert.deepEqual(periods, ['2000–2010', '2011–2021', '2022–2032', '2033–2043', '2044–2054',
    '2055–2065', '2066–2076', '2077–2088', '2089–2100']);
  const years = [];
  for (const period of periods) {
    h.click(period);
    const offered = gridChoices();
    assert.ok(offered.every(button => !button.disabled));
    assert.equal(offered.length, periods.indexOf(period) < 7 ? 11 : 12);
    years.push(...offered.map(button => Number(button.textContent)));
    h.click(period);
  }
  assert.equal(years.length, 101); assert.equal(new Set(years).size, 101);
  assert.equal(years[0], 2000); assert.equal(years.at(-1), 2100);
  h.click('2089–2100'); h.click('2100');
  assert.deepEqual(h.selected, ['2100-01-01']);
});

test('year navigation includes the final endpoint and follows the displayed three-column grid', () => {
  const h = harness('2100', { min: '2000-01-01', max: '2100-12-31' }, { precision: 'year' });
  const key = key => h.popup.dispatch('keydown', { key });
  h.button.dispatch('click');
  assert.equal(h.document.activeElement.textContent, '2100');
  assert.equal(h.buttons().find(button => button.textContent === '›').disabled, true);
  key('PageUp'); assert.equal(h.document.activeElement.textContent, '2077');
  key('ArrowDown'); assert.equal(h.document.activeElement.textContent, '2080');
  key('End'); assert.equal(h.document.activeElement.textContent, '2082');
  key('PageDown'); assert.equal(h.document.activeElement.textContent, '2100');
  key('Escape'); assert.deepEqual(h.selected, []);
});

test('short year ranges keep their real endpoint without a separate singleton period', () => {
  for (const [min, max, labels, lastCount] of [
    [2398, 2399, ['2398–2399'], 2],
    [2399, 2399, ['2399'], 1],
    [2389, 2399, ['2389–2399'], 11],
    [2379, 2399, ['2379–2388', '2389–2399'], 11],
  ]) {
    const h = harness(String(max), { min: `${min}-01-01`, max: `${max}-12-31` }, { precision: 'year' });
    h.button.dispatch('click');
    h.buttons().find(button => button.className === 'date-picker-title').dispatch('click');
    const grid = () => h.popup.all(node => node.getAttribute('role') === 'grid')[0];
    assert.deepEqual(grid().all(node => node.tagName === 'button').map(node => node.textContent), labels);
    h.click(labels.at(-1));
    assert.equal(grid().all(node => node.tagName === 'button').length, lastCount);
    grid().all(node => node.tagName === 'button').at(-1).dispatch('click');
    assert.deepEqual(h.selected, [`${max}-01-01`]);
  }
});


test('vertical arrows follow the centered final pair of years', () => {
  const h = harness('2032', { min: '2000-01-01', max: '2100-12-31' }, { precision: 'year' });
  h.button.dispatch('click');
  h.popup.dispatch('keydown', { key: 'ArrowUp' });
  assert.equal(h.document.activeElement.textContent, '2029');
  h.popup.dispatch('keydown', { key: 'ArrowDown' });
  assert.equal(h.document.activeElement.textContent, '2031');
});
