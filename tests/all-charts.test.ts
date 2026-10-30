import test from 'node:test';
import assert from 'node:assert/strict';
import { attachAllCharts } from '../src/views/all-charts.ts';
import { createChartPreview } from '../src/views/chart-preview-canvas.ts';
import { libraryDom } from './helpers/library-dom.ts';
import { dateDom } from './helpers/date-dom.ts';
import type { SavedChart } from '../shared/chart-types.ts';
import type {LibraryListChart} from '../src/domain/library-catalog.ts';

const charts = (count: number) => Array.from({ length: count }, (_, i) => ({ id: String(i), name: `Карта ${i}`, source: 'calculated' as const,
  birthDate: '1998-08-18', birthTime: '18:00', personality: [1], design: [2] }));
type HarnessOptions = { observe?: boolean; onOpen?: () => void; raster?: boolean; searchControls?: boolean; initialView?: Parameters<typeof attachAllCharts>[0]['initialView']; onChange?: () => void; onRowsChange?: () => void; canEdit?: () => boolean };
function harness({ observe = true, onOpen, raster = false, searchControls = false, initialView, onChange = () => {}, onRowsChange, canEdit }: HarnessOptions = {}) {
  const dom = libraryDom(), events = dateDom();
  const dialog = events.createElement('section'), button = events.createElement('button');
  dialog.hidden = true;
  const search = events.createElement('input'), resultCount = events.createElement('p'), empty = events.createElement('p');
  dialog.querySelector = selector => searchControls ? ({ '#allChartsSearch': search, '#allChartsCount': resultCount, '#allChartsEmpty': empty }[selector] ?? null) : null;
  dom.document.defaultView = events.defaultView;
  // Keep canvas identity observable when a row's surrounding markup changes.
  const createElement = dom.document.createElement.bind(dom.document);
  dom.document.createElement = tag => {
    const row = createElement(tag), html = Object.getOwnPropertyDescriptor(row, 'innerHTML')!;
    const query = row.querySelector.bind(row);
    let canvas: HTMLCanvasElement, edit: HTMLButtonElement, remove: HTMLButtonElement;
    Object.defineProperty(row, 'innerHTML', { configurable: true, get: html.get, set(value) {
      html.set!.call(row, value);
      canvas = { replaceWith(replacement: HTMLCanvasElement) { canvas = replacement; } } as HTMLCanvasElement;
      edit = { disabled: /data-chart-action="edit" disabled/.test(value) } as HTMLButtonElement;
      remove = { disabled: false } as HTMLButtonElement;
    } });
    row.querySelector = selector => selector === 'canvas' ? canvas : selector === '[data-chart-action="edit"]' ? edit
      : selector === '[data-chart-action="delete"]' ? remove : query(selector);
    return row;
  };
  const handlers = new Map(), jobs = new Map(), active = new Set(), painted = [], watched = new Set(), images: { src: string; onload: null; onerror: null; removeAttribute(): void; }[] = [];
  const list = dom.chartList;
  list.addEventListener = (type, listener) => handlers.set(type, listener);
  list.replaceChildren = () => { for (const row of [...dom.children] as const) row.remove(); };
  list.contains = target => dom.children.some(row => row === target || row.querySelector('.chart-card') === target);
  let intersection, nextJob = 0, disconnects = 0;
  const store = { charts: charts(300) as LibraryListChart[] }, session = { selectedId: '1' };
  const view = attachAllCharts({ button, dialog, list, getCharts: () => store.charts, onOpen, initialView, onChange, onRowsChange, canEdit, document: dom.document,
    createObserver: observe ? (callback, options) => {
      assert.equal(options.root, list); assert.equal(options.rootMargin, '120px 0px');
      intersection = callback;
      return { observe: row => watched.add(row), unobserve: row => watched.delete(row), disconnect() { watched.clear(); disconnects++; } };
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
  return { ...dom, dialog, button, list, store, session, view, jobs, active, painted, watched, images, tick, intersect, search, resultCount, empty,
    find(value: string) { search.value = value; search.dispatch('input'); }, resize: () => events.defaultView.dispatch('resize'),
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
  for (const selector of ['[data-chart-id]', '[data-chart-action]'] as const) {
    const h = harness(); h.view.show();
    const command = { closest: (candidate: string) => candidate === selector ? command : null };
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
  h.images[0].onload!(); h.images[1].onload!(); await Promise.resolve();
  assert.equal(result, undefined, 'the final visible thumbnail is still decoding');
  h.images[2].onload!(); await ready;
  assert.equal(result, true); assert.deepEqual(h.painted, ['0', '1', '2']);
});

test('a visible decode failure settles the page and an obsolete image cannot satisfy the reopened page', async () => {
  const h = harness({ raster: true }); h.view.show();
  const first = h.view.whenReady(); h.tick(); h.tick();
  const lateLoad = h.images[0].onload;
  h.images[1].onerror!();
  assert.equal(await first, false);
  h.view.close(); h.view.show();
  let nextResult;
  const next = h.view.whenReady().then(value => { nextResult = value; });
  h.tick(); h.tick(); lateLoad!(); await Promise.resolve();
  assert.equal(nextResult, undefined); assert.deepEqual(h.painted, []);
  for (const image of h.images.slice(3)) image.onload!();
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
  for (const action of ['resize', 'close'] as const) {
    const h = harness({ raster: true }); h.view.show();
    let result;
    const ready = h.view.whenReady().then(value => { result = value; });
    h.tick(); h.tick();
    const lateLoads = h.images.map(image => image.onload);
    if (action === 'resize') h.resize(); else h.view.close();
    await Promise.resolve(); assert.equal(result, null);
    for (const load of lateLoads) load!();
    await ready; assert.equal(result, null);
    h.view.close();
  }
});


test('choosing an already visible cards page still sends the explicit navigation command', () => {
  let requests = 0;
  const h = harness({ onOpen: () => { requests++; } });
  h.view.setVisible(true);
  const rows = [...h.children];
  h.button.dispatch('click');
  assert.equal(requests, 1);
  assert.deepEqual(h.children, rows, 'choosing the active page does not recreate its list');
  h.view.setVisible(true);
  assert.equal(requests, 1, 'the visibility projection is still not a navigation command');
});

test('card search matches normalized names, ISO and displayed dates, stored place and city', async () => {
  const h = harness({ searchControls: true });
  h.store.charts = [
    { ...h.store.charts[0], name: 'Алёна', birthDate: '2000-02-03', birthPlace: 'Омск' },
    { ...h.store.charts[1], name: 'Иван', birthDate: '1999-01-20', city: { name: 'Москва', region: 'Центр' } },
    { ...h.store.charts[2], name: 'Транзит', source: 'transit' },
    { ...h.store.charts[2], id:'current-transit', name:'Сейчас', source:'transit' },
  ];
  h.view.show();
  for (const [query, expected] of [
    ['  АЛЕНА  ', 'Алёна'], ['2000-02-03', 'Алёна'], ['03.02.2000', 'Алёна'],
    ['ОМСК', 'Алёна'], ['москва', 'Иван'], ['ИВАН Москва', 'Иван'],
  ]) {
    h.find(query);
    assert.equal(h.children.length, 1, query);
    assert.ok(h.list.innerHTML.includes(expected), query);
    assert.equal(h.empty.hidden, true);
    assert.match(h.resultCount.textContent, /1/);
  }
  h.find('не найдено');
  assert.equal(h.children.length, 0);
  assert.equal(h.empty.hidden, false);
  assert.equal(await h.view.whenReady(), true);
  h.find('');
  assert.equal(h.children.length, 3, 'saved transit remains manageable; the live current-transit placeholder is excluded');
  assert.equal(h.empty.hidden, true);
});

test('filtering releases obsolete previews and readiness, then restores the query across navigation', async () => {
  const h = harness({ searchControls: true, raster: true });
  h.view.show();
  const obsolete = h.view.whenReady();
  h.tick();
  const lateLoad = h.images[0].onload;
  h.find('Карта 299');
  assert.equal(await obsolete, null);
  assert.equal(h.active.size, 0);
  assert.equal(h.children.length, 1);
  assert.equal(h.watched.size, 1, 'only the filtered row enters the observer');
  const ready = h.view.whenReady(); h.tick(); lateLoad!();
  assert.deepEqual(h.painted, [], 'a removed preview cannot paint the filtered result');
  h.images.at(-1)!.onload!();
  assert.equal(await ready, true);
  assert.deepEqual(h.painted, ['299']);
  h.view.close(); h.store.charts = [...h.store.charts]; h.view.show();
  assert.equal(h.search.value, 'Карта 299');
  assert.equal(h.children.length, 1);
  assert.ok(h.list.innerHTML.includes('Карта 299'));
  assert.match(h.list.innerHTML, /data-chart-action="edit"/);
  assert.match(h.list.innerHTML, /data-chart-action="delete"/);
  h.find('карта 299');
  const first = h.children[0]; h.find('  КАРТА 299  ');
  assert.equal(h.children[0], first, 'equivalent queries do not replace the row');
});

test('a query entered while hidden filters before any of the 300 row previews are registered', () => {
  const h = harness({ searchControls: true });
  h.find('Карта 299');
  assert.equal(h.children.length, 0);
  h.view.show();
  assert.equal(h.children.length, 1);
  assert.equal(h.watched.size, 1);
  assert.equal(h.painted.length, 0);
});


test('cartotheque restores its raw search and keeps it while hidden, including a manual clear', () => {
  let changes = 0;
  const first = harness({ searchControls: true, onChange: () => { changes++; } });
  first.view.show(); first.find('КАРТА 29');
  assert.ok(changes > 0);
  const saved = first.view.snapshot;
  assert.deepEqual(saved, { query: 'КАРТА 29', searchOpen: false });
  const next = harness({ searchControls: true, initialView: saved });
  next.view.show();
  assert.equal(next.search.value, 'КАРТА 29');
  assert.equal(next.children.length, 13);
  next.view.close(); next.view.show();
  assert.equal(next.children.length, 13);
  next.find('');
  assert.equal(next.children.length, 300);
  assert.equal(next.view.snapshot.query, '');
});


test('card search restores its active selection only on the visible page and reports caret changes', () => {
  let changes=0;
  const focus={start:1,end:3,direction:'backward'} as const;
  const h=harness({searchControls:true,initialView:{query:'Анна',searchOpen:true,focus},onChange:()=>changes++});
  assert.equal(h.view.restoreInputFocus(),false);
  h.view.setVisible(true);
  assert.equal(h.view.restoreInputFocus(),true);
  assert.equal(h.search.ownerDocument.activeElement,h.search);
  assert.deepEqual(h.view.snapshot.focus,focus);
  const before=changes;
  h.search.setSelectionRange(2,2); h.search.ownerDocument.dispatch('selectionchange');
  assert.ok(changes>before);
  assert.equal(h.view.snapshot.focus.start,2);
  h.view.setVisible(false); assert.equal(h.view.snapshot.focus,undefined);
});

test('fresh copies of unchanged records retain all rows and decoded previews', async () => {
  const h = harness({ raster: true }); h.view.show();
  const ready = h.view.whenReady(); h.tick(); h.tick();
  for (const image of h.images) image.onload!();
  assert.equal(await ready, true);
  const rows = [...h.children], canvas = rows[0].querySelector('canvas');
  h.store.charts = h.store.charts.map(chart => {assert.ok('personality' in chart);return {...chart,personality:[...chart.personality],design:[...chart.design]};});
  h.view.update(); h.tick();
  assert.ok(h.children.every((row, i) => row === rows[i]));
  assert.equal(h.children[0].querySelector('canvas'), canvas);
  assert.equal(h.images.length, 3, 'an unchanged collection starts no new image decoding');
  assert.equal(h.active.size, 3);
});

test('renaming a card keeps its pending drawing and readiness; a note edit keeps its markup', async () => {
  const h = harness({ raster: true }); h.store.charts = h.store.charts.slice(0, 1); h.view.show();
  const row = h.children[0], canvas = row.querySelector('canvas');
  const ready = h.view.whenReady(); h.tick();
  h.store.charts = [{ ...h.store.charts[0], name: 'Новое имя', note: 'Заметка' }];
  h.view.update(); h.tick();
  assert.equal(h.children[0], row); assert.equal(row.querySelector('canvas'), canvas);
  assert.match(h.list.innerHTML, /Новое имя/);
  assert.equal(h.images.length, 1);
  h.images[0].onload!(); assert.equal(await ready, true);
  const markup = row.innerHTML;
  h.store.charts = [{ ...h.store.charts[0], note: 'Другая заметка' }];
  h.view.update(); h.tick();
  assert.equal(row.innerHTML, markup); assert.equal(h.images.length, 1);
});

test('changed gates replace only that drawing and ignore its obsolete decoded image', async () => {
  const h = harness({ raster: true }); h.store.charts = h.store.charts.slice(0, 2); h.view.show();
  const ready = h.view.whenReady(); h.tick();
  const lateLoad = h.images[0].onload, untouched = h.children[1].querySelector('canvas');
  h.store.charts = [{ ...h.store.charts[0], personality: [64], design: [47] }, h.store.charts[1]];
  h.view.update(); h.tick();
  assert.equal(h.images.length, 3, 'only the changed card starts another decode');
  assert.equal(h.children[1].querySelector('canvas'), untouched);
  lateLoad!(); assert.deepEqual(h.painted, []);
  h.images[1].onload!(); h.images[2].onload!();
  assert.equal(await ready, true);
  assert.deepEqual(h.painted, ['1', '0']);
  h.view.close(); assert.equal(h.active.size, 0);
});

test('reordering retains rows and pixels, filtering removes only excluded rows', async () => {
  const h = harness({ searchControls: true }); h.store.charts = h.store.charts.slice(0, 3);
  h.store.charts[0] = { ...h.store.charts[0], name: 'Целевая' }; h.view.show();
  const ready = h.view.whenReady(); h.tick(); h.tick(); assert.equal(await ready, true);
  const rows = [...h.children];
  h.store.charts = [h.store.charts[2], h.store.charts[0], h.store.charts[1]];
  h.view.update(); h.tick();
  assert.deepEqual(h.children, [rows[2], rows[0], rows[1]]);
  assert.deepEqual(h.painted, ['0', '1', '2']);
  h.find('Целевая'); h.tick();
  assert.deepEqual(h.children, [rows[0]]); assert.equal(h.watched.size, 1); assert.equal(h.active.size, 1);
  assert.deepEqual(h.painted, ['0', '1', '2']);
  h.view.close(); assert.equal(h.active.size, 0); assert.equal(h.jobs.size, 0);
});

test('availability changes keep existing controls and the deletion restriction set by the library', () => {
  let editable = true;
  const h = harness({ canEdit: () => editable }); h.store.charts = h.store.charts.slice(0, 1); h.view.show();
  const row = h.children[0], edit = row.querySelector('[data-chart-action="edit"]') as HTMLButtonElement;
  const remove = row.querySelector('[data-chart-action="delete"]') as HTMLButtonElement;
  remove.disabled = true;
  editable = false; h.view.update();
  assert.equal(row.querySelector('[data-chart-action="edit"]'), edit, 'a focused control must stay in the DOM');
  assert.equal(row.querySelector('[data-chart-action="delete"]'), remove);
  assert.equal(edit.disabled, true); assert.equal(remove.disabled, true);
  h.store.charts = [{ ...h.store.charts[0], name: 'Новое имя' }]; h.view.update();
  assert.equal((row.querySelector('[data-chart-action="delete"]') as HTMLButtonElement).disabled, true);
});


test('row availability is refreshed after catalogue creation and filtering, but not on unchanged updates', () => {
  let notified=0;
  const h=harness({searchControls:true,onRowsChange(){notified++;}});
  h.view.setVisible(true);
  assert.equal(notified,1);
  h.view.update();assert.equal(notified,1);
  h.store.charts=h.store.charts.map(chart=>({...chart,note:'Changed note'}));
  h.view.update();assert.equal(notified,1,'unchanged buttons need no repeated availability pass');
  h.find('missing');assert.equal(notified,1,'removed buttons need no availability pass');
  h.find('');assert.equal(notified,2);
});

test('light rows need no drawings and a complete arrival paints only its existing visible row',async()=>{
 const h=harness(),ready=h.store.charts[0] as SavedChart;
 const {id,name,source,birthDate,birthTime}=ready;
 h.store.charts=[{id,name,source:'calculated',birthDate:birthDate!,birthTime:birthTime!,revision:1,
  packages:{card:{kind:'card',sourceKey:JSON.stringify([id,1])},day:null,majorReturns:null}}];
 h.view.show();const row=h.children[0];h.intersect(0,true);h.tick();
 assert.equal(h.jobs.size,0);assert.equal(h.painted.length,0);assert.equal(await h.view.whenReady(),true);
 h.store.charts=[ready];h.view.update();h.tick();
 assert.equal(h.children[0],row);assert.deepEqual(h.painted,[id]);
 h.view.close();
});
