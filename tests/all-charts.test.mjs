import test from 'node:test';
import assert from 'node:assert/strict';
import { attachAllCharts } from '../src/views/all-charts.js';
import { createChartPreview } from '../src/views/chart-preview-canvas.js';
import { libraryDom } from './helpers/library-dom.mjs';
import { dateDom } from './helpers/date-dom.mjs';

const charts = count => Array.from({ length: count }, (_, i) => ({ id: String(i), name: `Карта ${i}`, source: 'calculated',
  birthDate: '1998-08-18', birthTime: '18:00', personality: [1], design: [2] }));
function harness({ observe = true, onOpen, raster = false } = {}) {
  const dom = libraryDom(), events = dateDom();
  const dialog = events.createElement('section'), button = events.createElement('button');
  dialog.hidden = true;
  dom.document.defaultView = events.defaultView;
  const handlers = new Map(), jobs = new Map(), active = new Set(), painted = [], watched = new Set(), images = [];
  const list = dom.chartList;
  list.addEventListener = (type, listener) => handlers.set(type, listener);
  list.replaceChildren = () => { for (const row of [...dom.children]) row.remove(); };
  list.contains = target => dom.children.some(row => row === target || row.querySelector('.chart-card') === target);
  let intersection, nextJob = 0, disconnects = 0;
  const store = { charts: charts(300) }, session = { selectedId: '1' };
  const view = attachAllCharts({ button, dialog, list, store, session, onOpen, document: dom.document,
    createObserver: observe ? (callback, options) => {
      assert.equal(options.root, list); assert.equal(options.rootMargin, '120px 0px');
      intersection = callback;
      return { observe: row => watched.add(row), disconnect() { watched.clear(); disconnects++; } };
    } : null,
    preview(canvas, chart, { onReady } = {}) {
      const drawing = { canvas, chart }; active.add(drawing);
      if (!raster) { painted.push(chart.id); onReady?.(true); return () => active.delete(drawing); }
      canvas.style = {};
      canvas.getContext = () => ({ drawImage() { painted.push(chart.id); } });
      const dispose = createChartPreview(canvas, chart, { onReady, createImage() {
        const image = { src: '', onload: null, onerror: null, removeAttribute() { this.src = ''; } };
        images.push(image); return image;
      } });
      return () => { dispose(); active.delete(drawing); };
    },
    schedule(callback) { const id = ++nextJob; jobs.set(id, callback); return id; }, cancel: id => jobs.delete(id),
  });
  const tick = () => { const batch = [...jobs]; jobs.clear(); for (const [, callback] of batch) callback(); };
  const intersect = (index, visible) => intersection([{ target: dom.children[index], isIntersecting: visible }]);
  return { ...dom, dialog, button, list, store, session, view, jobs, active, painted, watched, images, tick, intersect, resize: () => events.defaultView.dispatch('resize'),
    get disconnects() { return disconnects; }, scroll() { handlers.get('scroll')?.(); } };
}

test('opening all charts renders saved rows but prepares only observed previews and releases those leaving the margin', () => {
  const h = harness();
  h.view.update(); assert.equal(h.children.length, 0); assert.equal(h.painted.length, 0);
  h.button.dispatch('click');
  assert.equal(h.dialog.hidden, false); assert.equal(h.children.length, 300); assert.equal(h.watched.size, 300);
  assert.equal(h.painted.length, 0, 'a large collection is not rasterized before visibility is known');
  h.intersect(0, true); h.intersect(1, true); h.intersect(10, true);
  h.tick(); assert.equal(h.active.size, 2, 'one task prepares only a small batch');
  h.tick(); assert.equal(h.active.size, 3);
  h.intersect(0, false); assert.equal(h.active.size, 2);
  h.intersect(0, true); h.tick();
  assert.deepEqual(h.painted, ['0', '1', '10', '0'], 'returning near the viewport creates the preview again');
  assert.match(h.list.innerHTML, /18\.08\.1998 · 18:00/);
  assert.match(h.list.innerHTML, /data-chart-action="edit"/); assert.match(h.list.innerHTML, /data-chart-action="delete"/);
});

test('closing all charts releases drawings, pending batches and DOM; reopening reads the current store', () => {
  const h = harness(); h.view.show();
  h.intersect(0, true); h.intersect(1, true); h.intersect(2, true); h.tick();
  assert.equal(h.jobs.size, 1);
  const lateBatch = [...h.jobs.values()][0];
  h.view.setVisible(false);
  lateBatch();
  assert.equal(h.active.size, 0); assert.equal(h.jobs.size, 0); assert.equal(h.children.length, 0);
  assert.equal(h.watched.size, 0); assert.equal(h.dialog.hidden, true);
  h.store.charts = [{ ...h.store.charts[0], name: 'Новое имя' }]; h.view.show();
  assert.equal(h.children.length, 1); assert.match(h.list.innerHTML, /Новое имя/);
  assert.equal(h.painted.length, 2, 'reopening does not reuse released pixel buffers');
});

test('all cards stay unselected on opening, selection updates and rebuilding without changing the chosen chart', () => {
  const h = harness();
  const assertNeutral = () => {
    for (const row of h.children) {
      assert.notEqual(row.dataset.active, 'true');
      const button = row.querySelector('.chart-card');
      assert.equal(button.dataset.active, 'false');
      assert.equal(button.getAttribute('aria-pressed'), 'false');
    }
  };
  h.view.show(); assertNeutral(); assert.equal(h.session.selectedId, '1');
  h.intersect(1, true); h.tick();
  const rows = [...h.children]; h.session.selectedId = '2'; h.view.update();
  assert.deepEqual(h.children, rows); assert.deepEqual(h.painted, ['1']);
  assertNeutral(); assert.equal(h.session.selectedId, '2');
  h.store.charts = [...h.store.charts]; h.view.update(); assertNeutral();
  h.view.close(); h.view.show(); assertNeutral(); assert.equal(h.session.selectedId, '2');
});

test('the visibility fallback still prepares a bounded scroll margin instead of all 300 drawings', () => {
  const h = harness({ observe: false }); h.view.show();
  for (let i = 0; i < 5; i++) h.tick();
  assert.ok(h.active.size > 0 && h.active.size < 10);
  h.view.close(); assert.equal(h.active.size, 0);
});

test('choosing or managing a chart leaves navigation to the existing library command', () => {
  for (const selector of ['[data-chart-id]', '[data-chart-action]']) {
    const h = harness(); h.view.show();
    const command = { closest: candidate => candidate === selector ? command : null };
    let stopped = false;
    h.dialog.dispatch('click', { target: command, stopPropagation() { stopped = true; } });
    assert.equal(h.dialog.hidden, false, 'the workspace owner decides when the page changes');
    assert.equal(stopped, false, 'the existing document-level library command remains the sole owner');
  }
});

test('navigation requests leave visibility to the workspace projection without a feedback loop', () => {
  let requests = 0;
  const h = harness({ onOpen: () => { requests++; } });
  h.button.dispatch('click');
  assert.equal(requests, 1);
  assert.equal(h.dialog.hidden, true, 'a navigation request does not create a second screen owner');
  assert.equal(h.children.length, 0);
  h.view.setVisible(true);
  assert.equal(h.dialog.hidden, false); assert.equal(h.children.length, 300);
  h.intersect(0, true); h.tick();
  const rows = [...h.children];
  h.view.setVisible(true);
  assert.deepEqual(h.children, rows); assert.deepEqual(h.painted, ['0']);
  assert.equal(requests, 1, 'projecting the current screen never requests navigation again');
  h.view.setVisible(false);
  assert.equal(h.dialog.hidden, true); assert.equal(h.children.length, 0);
  assert.equal(h.active.size, 0);
  h.view.update();
  assert.equal(h.children.length, 0, 'hidden pages do not rebuild their rows');
});


test('initial readiness waits only for currently visible previews, including before observer delivery', async () => {
  const h = harness(); h.view.show();
  let settled = false;
  const ready = h.view.whenReady().then(value => { settled = true; return value; });
  await Promise.resolve(); assert.equal(settled, false);
  h.tick(); await Promise.resolve(); assert.equal(settled, false, 'the third visible card is not painted in the first two-card batch');
  h.tick(); assert.equal(await ready, true);
  assert.deepEqual(h.painted, ['0', '1', '2']);
  assert.equal(h.active.size, 3, 'the other 297 drawings do not delay the first screen');
});

test('closing an initial cards page settles its obsolete readiness and an empty page is ready immediately', async () => {
  const h = harness(); h.view.show();
  const obsolete = h.view.whenReady(); h.view.close();
  assert.equal(await obsolete, null); assert.equal(h.jobs.size, 0);
  assert.equal(await h.view.whenReady(), null, 'a hidden page has no current viewport snapshot');
  h.store.charts = []; h.view.show();
  assert.equal(await h.view.whenReady(), true);
});


test('visible page readiness waits for decoded canvas images rather than queued preview creation', async () => {
  const h = harness({ raster: true }); h.view.show();
  let result;
  const ready = h.view.whenReady().then(value => { result = value; });
  h.tick(); h.tick(); await Promise.resolve();
  assert.equal(h.images.length, 3); assert.deepEqual(h.painted, []);
  assert.equal(result, undefined, 'created Image objects have not painted their canvases');
  h.images[0].onload(); h.images[1].onload(); await Promise.resolve();
  assert.equal(result, undefined, 'the final visible thumbnail is still decoding');
  h.images[2].onload(); await ready;
  assert.equal(result, true); assert.deepEqual(h.painted, ['0', '1', '2']);
});

test('a visible decode failure settles the page and an obsolete image cannot satisfy the reopened page', async () => {
  const h = harness({ raster: true }); h.view.show();
  const first = h.view.whenReady(); h.tick(); h.tick();
  const lateLoad = h.images[0].onload;
  h.images[1].onerror();
  assert.equal(await first, false);
  h.view.close(); h.view.show();
  let nextResult;
  const next = h.view.whenReady().then(value => { nextResult = value; });
  h.tick(); h.tick(); lateLoad(); await Promise.resolve();
  assert.equal(nextResult, undefined); assert.deepEqual(h.painted, []);
  for (const image of h.images.slice(3)) image.onload();
  await next; assert.equal(nextResult, true);
});

test('an entry leaving the initial viewport before its paint cancels obsolete readiness', async () => {
  const h = harness(); h.view.show();
  let result;
  const ready = h.view.whenReady().then(value => { result = value; });
  h.intersect(2, false); h.tick(); h.tick(); await Promise.resolve();
  assert.equal(result, null, 'a removed pending drawing cancels its obsolete viewport snapshot');
  assert.equal(h.jobs.size, 0); await ready;
});

test('resize and release settle a pending viewport snapshot without accepting late pixels', async () => {
  for (const action of ['resize', 'close']) {
    const h = harness({ raster: true }); h.view.show();
    let result;
    const ready = h.view.whenReady().then(value => { result = value; });
    h.tick(); h.tick();
    const lateLoads = h.images.map(image => image.onload);
    if (action === 'resize') h.resize(); else h.view.close();
    await Promise.resolve(); assert.equal(result, null);
    for (const load of lateLoads) load();
    await ready; assert.equal(result, null);
    h.view.close();
  }
});
