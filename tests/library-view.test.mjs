import test from 'node:test';
import assert from 'node:assert/strict';
import { createChartLibraryView } from '../src/views/library.js';
import { libraryDom } from './helpers/library-dom.mjs';

const charts = count => Array.from({ length: count }, (_, index) => ({ id: String(index), name: `Chart ${index}`, source: 'manual', personality: [index % 64 + 1], design: [] }));
function harness() {
  const dom = libraryDom(), rendered = [], jobs = new Map(), observed = new Set();
  let nextJob = 0, notify;
  const view = createChartLibraryView({ ...dom,
    thumbnail: chart => { rendered.push(chart.id); return `preview:${chart.id}`; },
    createObserver(callback, options) {
      notify = callback;
      assert.equal(options.root, dom.chartList); assert.equal(options.rootMargin, '120px 0px');
      return { observe: row => observed.add(row), unobserve: row => observed.delete(row), disconnect: () => observed.clear() };
    },
    schedule: callback => { jobs.set(++nextJob, callback); return nextJob; }, cancel: id => jobs.delete(id),
  });
  return { ...dom, view, rendered, jobs, observed,
    visible(indices) { notify(indices.map(index => ({ target: dom.children[index], isIntersecting: true }))); },
    tick() { const [id, callback] = jobs.entries().next().value; jobs.delete(id); callback(); },
  };
}

test('closed library does no row or SVG work; opening prepares only intersecting thumbnails in bounded batches', () => {
  const h = harness(), saved = charts(500);
  h.view.update(saved, '0');
  assert.equal(h.libraryCount.textContent, '500');
  assert.equal(h.children.length, 0); assert.deepEqual(h.rendered, []);
  h.view.show();
  assert.equal(h.children.length, 500); assert.deepEqual(h.rendered, []);
  h.visible([0, 1, 2, 3, 4, 5]);
  assert.equal(h.jobs.size, 1); h.tick();
  assert.deepEqual(h.rendered, ['0', '1', '2', '3']);
  h.tick(); assert.deepEqual(h.rendered, ['0', '1', '2', '3', '4', '5']);
  assert.equal(h.jobs.size, 0);
});

test('selection and repeated updates preserve row, thumbnail and action-menu identity', () => {
  const h = harness(), saved = charts(10);
  h.view.update(saved, '0'); h.view.show(); h.visible([0]); h.tick();
  const rows = [...h.children], button = rows[0].querySelector('.chart-card'), image = rows[0].querySelector('img');
  for (let index = 1; index <= 9; index++) h.view.update(saved, String(index));
  assert.deepEqual(h.children, rows); assert.equal(rows[0].querySelector('.chart-card'), button);
  assert.equal(rows[0].querySelector('img'), image); assert.equal(image.src, 'preview:0');
  assert.equal(button.getAttribute('aria-pressed'), 'false');
  assert.equal(rows[9].querySelector('.chart-card').getAttribute('aria-pressed'), 'true');
  assert.deepEqual(h.rendered, ['0']); assert.equal(h.jobs.size, 0);
});

test('closing cancels deferred images; reopening keeps finished images and deleted rows cannot paint later', () => {
  const h = harness(), saved = charts(8);
  h.view.update(saved, '0'); h.view.show(); h.visible([0, 1, 2, 3, 4, 5]); h.tick();
  h.view.hide(); assert.equal(h.jobs.size, 0); assert.equal(h.observed.size, 0);
  h.visible([7]); assert.equal(h.jobs.size, 0);
  h.view.update(saved.slice(1), '1'); assert.equal(h.children.length, 8, 'closed updates defer list work');
  h.view.show(); assert.equal(h.children.length, 7); assert.deepEqual(h.rendered, ['0', '1', '2', '3']);
  h.visible([3]); h.tick(); assert.deepEqual(h.rendered, ['0', '1', '2', '3', '4']);
});

test('library presentation preserves repeated existing IDs without deduplicating saved records', () => {
  const h = harness(), first = charts(1)[0], second = { ...first, name: 'Another record' };
  const saved = [first, second]; h.view.update(saved, '0'); h.view.show();
  assert.equal(h.children.length, 2); assert.equal(h.libraryCount.textContent, '2');
  for (const row of h.children) assert.equal(row.querySelector('.chart-card').getAttribute('aria-pressed'), 'true');
  h.visible([0, 1]); h.tick(); assert.deepEqual(h.rendered, ['0', '0']);
  assert.equal(saved[0], first); assert.equal(saved[1], second);
});
