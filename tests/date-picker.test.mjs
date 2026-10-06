import test from 'node:test';
import assert from 'node:assert/strict';
import { attachDatePicker } from '../src/views/date-picker.js';
import { dateDom } from './helpers/date-dom.mjs';
function harness(value = '15.08.2025', bounds = { min: '1801-01-01', max: '2399-12-31' }, options = {}) {
  const document = dateDom(), input = document.createElement('input'), button = document.createElement('button');
  input.id = 'date'; input.value = value; input.setAttribute('aria-label', 'Дата'); document.body.append(input, button);
  const selected = [], picker = attachDatePicker({ input, button, getBounds: () => bounds, onSelect: value => selected.push(value), ...options });
  const popup = document.body.children.at(-1);
  const buttons = () => popup.all(node => node.tagName === 'button');
  const click = text => { const target = buttons().find(node => node.textContent === text && !node.hidden); assert.ok(target, text); target.dispatch('click'); };
  return { document, input, button, popup, picker, selected, buttons, click };
}
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
test('year precision keeps period navigation and cancel without inventing a year', () => {
  const h = harness('', { min: '1996-01-01', max: '2096-12-31' }, { precision: 'year' });
  h.button.dispatch('click'); h.click('1996–2020'); h.click('2071–2095'); h.click('2095');
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
    h => h.popup.dispatch('keydown', { key: 'Escape' }), h => h.popup.dispatch('keydown', { key: 'Tab' }),
    h => h.click('×'), h => h.button.dispatch('click'), h => h.picker.close()]) {
    const h = harness('04.10.2026'); h.button.dispatch('click'); h.click('2027');
    assert.deepEqual(h.selected, []); dismiss(h);
    assert.equal(h.popup.hidden, true); assert.deepEqual(h.selected, ['2027-01-01']);
    h.picker.close(); assert.deepEqual(h.selected, ['2027-01-01']);
  }
});
test('dismissing a chosen month commits its first day and a new session has no pending choice', () => {
  const h = harness('04.10.2026'); h.button.dispatch('click'); h.click('2027'); h.click('Октябрь');
  assert.deepEqual(h.selected, []); h.click('×'); assert.deepEqual(h.selected, ['2027-10-01']);
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
  h.click('×'); assert.deepEqual(h.selected, ['2026-10-04']);
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
test('outside pointer, focus departure and repeated opens clean up document/window listeners', () => {
  const h = harness();
  for (let i = 0; i < 5; i++) {
    h.button.dispatch('click'); assert.equal(h.document.listenerCount('pointerdown'), 1);
    h.document.dispatch('pointerdown', { target: h.input }); assert.equal(h.picker.opened, false);
    assert.equal(h.document.listenerCount('pointerdown'), 0); assert.equal(h.document.defaultView.listenerCount('resize'), 0);
  }
  h.button.dispatch('click'); h.input.focus(); assert.equal(h.picker.opened, false);
});
test('popup clamps to the narrow viewport and is positioned above the bottom controls', () => {
  const h = harness(); h.button.dispatch('click');
  assert.equal(h.popup.style.left, '26px'); assert.equal(h.popup.style.top, '422px');
});

test('visual viewport keyboard height limits the scrollable popup before it is positioned', () => {
  const h = harness();
  h.document.defaultView.visualViewport = { width: 320, height: 210, offsetTop: 100, offsetLeft: 0, addEventListener() {}, removeEventListener() {} };
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
    h.click('×'); assert.deepEqual(h.selected, ['1801-01-01']);
  }
});
