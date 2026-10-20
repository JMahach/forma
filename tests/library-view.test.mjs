import test from 'node:test';
import assert from 'node:assert/strict';
import { createChartLibraryView } from '../src/views/library.js';
import { libraryDom } from './helpers/library-dom.mjs';

const charts = count => Array.from({ length: count }, (_, index) => ({ id: String(index), name: `Chart ${index}`, source: 'manual', personality: [index % 64 + 1], design: [] }));
function harness() {
  const dom = libraryDom();
  const view = createChartLibraryView({ ...dom });
  return { ...dom, view };
}

test('compact saved-chart rows contain names, dates and actions without requesting previews or visibility work', () => {
  const dom = libraryDom();
  const unexpected = () => assert.fail('the compact navigation list does not prepare previews');
  const view = createChartLibraryView({ ...dom, thumbnail: unexpected, createObserver: unexpected, schedule: unexpected });
  const saved = [{ ...charts(1)[0], name: 'Анна', source: 'calculated', birthDate: '1998-08-18', birthTime: '18:00' }];
  view.update(saved, '0'); view.show();
  const html = dom.chartList.innerHTML;
  assert.match(html, /Анна/); assert.match(html, /18\.08\.1998 · 18:00/);
  assert.match(html, /data-chart-action="edit"/); assert.match(html, /data-chart-action="delete"/);
  assert.doesNotMatch(html, /<img|<canvas|<svg/);
});

test('closed list defers rows and opening creates all saved entries once', () => {
  const h = harness(), saved = charts(500);
  h.view.update(saved, '0');
  assert.equal(h.libraryCount.textContent, '500'); assert.equal(h.children.length, 0);
  h.view.show(); assert.equal(h.children.length, 500);
  const rows = [...h.children];
  h.view.show(); h.view.hide(); h.view.show();
  assert.deepEqual(h.children, rows);
});

test('open additions and reordering preserve existing row identity', () => {
  const h = harness(), saved = charts(3);
  saved.push({ ...saved[0], name: 'Repeated ID' });
  h.view.update(saved, '0'); h.view.show();
  const rows = [...h.children], added = { ...saved[0], id: 'new', name: 'Added' };
  h.view.update([saved[2], saved[0], saved[1], saved[3], added], '0');
  assert.deepEqual(h.children.slice(0, 4), [rows[2], rows[0], rows[1], rows[3]]);
  assert.equal(h.libraryCount.textContent, '5'); assert.equal(h.children.length, 5);
});

test('selection and repeated updates preserve rows and action-menu identity', () => {
  const h = harness(), saved = charts(10);
  h.view.update(saved, '0'); h.view.show();
  const rows = [...h.children], button = rows[0].querySelector('.chart-card');
  for (let index = 1; index <= 9; index++) h.view.update(saved, String(index));
  assert.deepEqual(h.children, rows); assert.equal(rows[0].querySelector('.chart-card'), button);
  assert.equal(button.getAttribute('aria-pressed'), 'false');
  assert.equal(rows[9].querySelector('.chart-card').getAttribute('aria-pressed'), 'true');
});

test('closed updates defer list changes until reopening without losing surviving rows', () => {
  const h = harness(), saved = charts(8);
  h.view.update(saved, '0'); h.view.show();
  const rows = [...h.children]; h.view.hide();
  h.view.update(saved.slice(1), '1'); assert.equal(h.children.length, 8);
  h.view.show(); assert.deepEqual(h.children, rows.slice(1));
  assert.equal(h.children[0].querySelector('.chart-card').getAttribute('aria-pressed'), 'true');
});

test('library presentation preserves repeated existing IDs without deduplicating saved records', () => {
  const h = harness(), first = charts(1)[0], second = { ...first, name: 'Another record' };
  const saved = [first, second]; h.view.update(saved, '0'); h.view.show();
  assert.equal(h.children.length, 2); assert.equal(h.libraryCount.textContent, '2');
  for (const row of h.children) assert.equal(row.querySelector('.chart-card').getAttribute('aria-pressed'), 'true');
  assert.equal(saved[0], first); assert.equal(saved[1], second);
});
