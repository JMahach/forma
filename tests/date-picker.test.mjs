import test from 'node:test';
import assert from 'node:assert/strict';
import { attachDatePicker } from '../src/views/date-picker.js';
import { dateDom } from './helpers/date-dom.mjs';
function harness(value = '15.08.2025') {
  const document = dateDom(), input = document.createElement('input'), button = document.createElement('button');
  input.id = 'date'; input.value = value; input.setAttribute('aria-label', 'Дата'); document.body.append(input, button);
  const selected = [], picker = attachDatePicker({ input, button, getBounds: () => ({ min: '1801-01-01', max: '2399-12-31' }), onSelect: value => selected.push(value) });
  const popup = document.body.children.at(-1);
  const buttons = () => popup.all(node => node.tagName === 'button');
  const click = text => { const target = buttons().find(node => node.textContent === text && !node.hidden); assert.ok(target, text); target.dispatch('click'); };
  return { document, input, button, popup, picker, selected, buttons, click };
}
test('first screen is a year grid; year commits Jan 1 immediately and month/day remain optional', () => {
  const h = harness(); h.button.dispatch('click');
  assert.equal(h.popup.dataset.view, 'years'); assert.equal(h.button.getAttribute('aria-expanded'), 'true');
  assert.equal(h.document.activeElement.textContent, '2025');
  h.click('›'); h.click('2027');
  assert.deepEqual(h.selected, ['2027-01-01']); assert.equal(h.popup.dataset.view, 'months');
  h.click('Февраль'); assert.equal(h.selected.at(-1), '2027-02-01'); assert.equal(h.popup.dataset.view, 'days');
  h.click('28'); assert.equal(h.selected.at(-1), '2027-02-28'); assert.equal(h.popup.hidden, true);
  assert.equal(h.document.activeElement, h.button);
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
