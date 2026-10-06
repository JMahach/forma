import test from 'node:test';
import assert from 'node:assert/strict';
import { createChartLibraryView } from '../src/views/library.js';
import { libraryDom } from './helpers/library-dom.mjs';

const charts = count => Array.from({ length: count }, (_, index) => ({ id: String(index), name: `Chart ${index}`, source: 'manual', personality: [index % 64 + 1], design: [] }));
function harness({ withObserver = true } = {}) {
  const dom = libraryDom(), rendered = [], jobs = new Map(), observed = new Set();
  const operations = { observe: 0, rowRect: 0, listRect: 0 };
  let nextJob = 0, notify, onScroll;
  const createElement = dom.document.createElement, listRect = dom.chartList.getBoundingClientRect;
  dom.document.createElement = (...args) => {
    const row = createElement(...args), rowRect = row.getBoundingClientRect;
    row.getBoundingClientRect = () => { operations.rowRect++; return rowRect(); };
    return row;
  };
  dom.chartList.getBoundingClientRect = () => { operations.listRect++; return listRect(); };
  dom.chartList.addEventListener = (type, callback) => { if (type === 'scroll') onScroll = callback; };
  const view = createChartLibraryView({ ...dom,
    thumbnail: chart => { rendered.push(chart.id); return `preview:${chart.id}`; },
    createObserver: withObserver ? (callback, options) => {
      notify = callback;
      assert.equal(options.root, dom.chartList); assert.equal(options.rootMargin, '120px 0px');
      return { observe: row => { operations.observe++; observed.add(row); }, unobserve: row => observed.delete(row), disconnect: () => observed.clear() };
    } : null,
    schedule: callback => { jobs.set(++nextJob, callback); return nextJob; }, cancel: id => jobs.delete(id),
  });
  return { ...dom, view, rendered, jobs, observed, operations,
    visible(indices) { notify(indices.map(index => ({ target: dom.children[index], isIntersecting: true }))); },
    tick() { const [id, callback] = jobs.entries().next().value; jobs.delete(id); callback(); },
    scrollTo(value) { dom.scrollTop = value; onScroll(); },
  };
}

for (const withObserver of [true, false]) test(`opening 500 rows connects visibility once (observer: ${withObserver})`, () => {
  const h = harness({ withObserver });
  h.view.update(charts(500), '0'); h.view.show();
  const expected = withObserver ? { observe: 500, rowRect: 0, listRect: 0 } : { observe: 0, rowRect: 500, listRect: 1 };
  assert.deepEqual(h.operations, expected);
  const rows = [...h.children];
  h.view.show();
  assert.deepEqual(h.operations, expected, 'showing an already open panel does not reconnect');
  h.view.hide(); h.view.show();
  assert.deepEqual(h.children, rows, 'reopening retains rows');
  assert.deepEqual(h.operations, Object.fromEntries(Object.entries(expected).map(([key, value]) => [key, value * 2])), 'reopening reconnects unfinished rows once');
});

test('open additions and reordering preserve rows and observe every unfinished entry', () => {
  const h = harness(), saved = charts(3);
  saved.push({ ...saved[0], name: 'Repeated ID' });
  h.view.update(saved, '0'); h.view.show();
  h.visible([0, 1]); h.tick();
  const rows = [...h.children], before = h.operations.observe;
  const added = { ...saved[0], id: 'new', name: 'Added' };
  h.view.update([saved[2], saved[0], saved[1], saved[3], added], '0');
  assert.deepEqual(h.children.slice(0, 4), [rows[2], rows[0], rows[1], rows[3]]);
  assert.equal(h.operations.observe - before, 3);
  assert.deepEqual([...h.observed], [rows[2], rows[3], h.children[4]]);
  h.visible([0, 3, 4]); h.tick();
  assert.deepEqual(h.rendered, ['0', '1', '2', '0', 'new']);
  assert.equal(h.libraryCount.textContent, '5');
});

test('fallback scrolling and reopening preserve the visible range and four-thumbnail batches', () => {
  const h = harness({ withObserver: false }), saved = charts(20);
  h.view.update(saved, '0'); h.view.show();
  h.tick(); assert.deepEqual(h.rendered, ['0', '1', '2', '3']);
  h.tick(); assert.deepEqual(h.rendered, ['0', '1', '2', '3', '4']);
  h.scrollTo(760); h.tick();
  assert.deepEqual(h.rendered.slice(5), ['8', '9', '10', '11']);
  h.view.hide(); assert.equal(h.jobs.size, 0);
  const rows = [...h.children], before = { ...h.operations };
  h.view.show(); h.tick();
  assert.deepEqual(h.rendered.slice(9), ['12', '13', '14']);
  assert.deepEqual(h.children, rows);
  assert.equal(h.operations.rowRect - before.rowRect, 20);
  assert.equal(h.operations.listRect - before.listRect, 1);
  assert.equal(h.jobs.size, 0);
});

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
