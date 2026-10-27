import { getConnectionMode, subscribeConnection } from '../src/data/http-transport.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createChartLibraryView } from '../src/views/library.ts';
import { libraryDom } from './helpers/library-dom.ts';

const charts = (count: number) => Array.from({ length: count }, (_, index) => ({ id: String(index), name: `Chart ${index}`, source: 'manual' as const, personality: [index % 64 + 1], design: [] }));
function harness() {
  const dom = libraryDom();
  const view = createChartLibraryView({ ...dom });
  return { ...dom, view };
}

test('compact saved-chart rows contain names, dates and actions without requesting previews or visibility work', () => {
  const dom = libraryDom();
  const unexpected = () => assert.fail('the compact navigation list does not prepare previews');
  const view = createChartLibraryView({ ...dom, thumbnail: unexpected, createObserver: unexpected, schedule: unexpected });
  const saved = [{ ...charts(1)[0], name: 'Анна', source: 'calculated' as const, birthDate: '1998-08-18', birthTime: '18:00' }];
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

test('edit availability is identical in menu and card-catalog rows while ready cards stay openable', async t => {
 const {createStandConnection}=await import('./helpers/preview/stand-connection.ts');
 const {configureTransportSimulation}=await import('../src/data/http-transport.ts');
 const {renderChartLibraryRow}=await import('../src/views/library.ts');
 const connection=createStandConnection();configureTransportSimulation(connection);t.after(()=>configureTransportSimulation(null));
 for(const mode of ['offline','server','online'] as const){
  connection.set(mode);
  for(const preview of [false,true]){
   const html=renderChartLibraryRow(charts(1)[0],false,{preview,editDisabled:connection.current==='offline'});
   const edit=html.match(/<button[^>]*data-chart-action="edit"[^>]*>/)![0];
   assert.equal(/\bdisabled\b/.test(edit),mode==='offline');
   assert.doesNotMatch(html.match(/<button class="chart-card"[^>]*>/)![0],/disabled/);
   assert.doesNotMatch(html.match(/<button[^>]*data-chart-action="delete"[^>]*>/)![0],/disabled/,'current deletion is local, not a server write');
  }
 }
});
test('live connection changes update New and every Edit without resetting the list or bypassing guards', async t=>{
 const {attachChartLibrary}=await import('../src/views/library.ts');
 const {createStandConnection}=await import('./helpers/preview/stand-connection.ts');
 const {configureTransportSimulation}=await import('../src/data/http-transport.ts');
 const connection=createStandConnection();configureTransportSimulation(connection);t.after(()=>configureTransportSimulation(null));
 const nodes=new Map(), handlers=new Map();let newCalls=0,editCalls=0;
 function node(id){if(!nodes.has(id))nodes.set(id,{id,disabled:false,dataset:{},classList:{toggle(){}},setAttribute(){},contains(){return false;},focus(){},addEventListener(type,fn){handlers.set(id+':'+type,fn);}});return nodes.get(id);}
 const edits=[node('menuEdit'),node('catalogEdit')];for(const edit of edits){edit.dataset={chartAction:'edit',actionChartId:'0'};edit.closest=selector=>selector==='[data-chart-action]'?edit:{open:true};}
 const document={getElementById:node,querySelectorAll:selector=>selector==='[data-chart-action="edit"]'?edits:[],querySelector:()=>null,addEventListener(type,fn){handlers.set('document:'+type,fn);}};
 attachChartLibrary({getConnectionMode, subscribeConnection, document,getCharts: () => charts(1), removeChart() {},session:{selectedId:'0'},view:{update(){},show(){},hide(){}},onNew(){newCalls++;},onEdit(){editCalls++;},onSelect(){}});
 connection.set('offline');assert.equal(node('newChartButton').disabled,true);assert.ok(edits.every(x=>x.disabled));
 handlers.get('newChartButton:click')();handlers.get('document:click')({target:edits[0]});assert.equal(newCalls,0);assert.equal(editCalls,0);
 connection.set('server');assert.equal(node('newChartButton').disabled,false);assert.ok(edits.every(x=>!x.disabled));
 handlers.get('newChartButton:click')();handlers.get('document:click')({target:edits[1]});assert.equal(newCalls,1);assert.equal(editCalls,1);
});


test('compact selection keeps the whole group red and marks only the displayed card current', () => {
  const h = harness(), saved = charts(5);
  h.view.update(saved, '3', ['0', '3']); h.view.show();
  assert.deepEqual(h.children.map(row => row.dataset.active), ['true', 'false', 'false', 'true', 'false']);
  assert.deepEqual(h.children.map(row => row.dataset.current), ['false', 'false', 'false', 'true', 'false']);
  const rows = [...h.children];
  h.view.update(saved, '0', ['0', '3']);
  assert.deepEqual(h.children, rows);
  assert.equal(rows[3].dataset.active, 'true');
  assert.equal(rows[3].dataset.current, 'false');
  assert.equal(rows[0].querySelector('.chart-card').getAttribute('aria-current'), 'true');
  h.view.update(saved, null, ['0', '3']);
  assert.ok(rows.every(row => row.dataset.current === 'false'));
  assert.equal(rows[0].dataset.active, 'true', 'opening another section retains the group');
});


test('menu clicks and arrow keys open only selected cards, while the catalogue remains single-select', async () => {
  const {attachChartLibrary} = await import('../src/views/library.ts');
  const {createPanelState} = await import('../src/state/panels.ts');
  const nodes = new Map(), handlers = new Map();
  let focused = null, modal = false, library;
  function node(id) {
    if (!nodes.has(id)) nodes.set(id, {id, dataset: {}, classList: {toggle() {}}, setAttribute() {},
      contains(item) {return item?.inList === true;}, focus() {focused = id;}, clientHeight: 300, scrollTop: 0,
      getBoundingClientRect() {return {top: 0, bottom: id === 'chartList' ? 300 : 52, height: id === 'chartList' ? 300 : 52};},
      querySelectorAll() {return cards;}, addEventListener(type, fn) {handlers.set(id + ':' + type, fn);}});
    return nodes.get(id);
  }
  const cards = charts(5).map(chart => {
    const card = node(chart.id); card.inList = true; card.dataset.chartId = chart.id;
    card.closest = selector => selector === '[data-chart-action]' ? null : card; return card;
  });
  const document = {getElementById: node, querySelectorAll: () => [], querySelector: () => modal ? {} : null,
    addEventListener(type, fn) {handlers.set('document:' + type, fn);}};
  const session = {selectedId: '0'}, opened = [], panels = createPanelState(); panels.setLeft(true);
  library = attachChartLibrary({getConnectionMode, subscribeConnection, document, panels, getCharts: () => charts(5), removeChart() {}, session,
    view: {update() {}, show() {}, hide() {}}, onNew() {}, onEdit() {}, onUpdate() {},
    onSelect(id, options) {opened.push(id); session.selectedId = id; if (!options?.keepMenuOpen) panels.setLeft(false); library.render();}});
  const click = (id, shiftKey = false) => handlers.get('document:click')({target: cards[+id], shiftKey});
  function key(key, target = cards[3], extras = {}) {
    let prevented = false;
    handlers.get('chartList:keydown')({key, target, preventDefault() {prevented = true;}, stopPropagation() {}, ...extras});
    return prevented;
  }
  click('3', true); click('1', true);
  assert.deepEqual(library.selection, ['0', '3', '1']); assert.equal(session.selectedId, '1');
  assert.equal(key('ArrowDown'), true); assert.equal(session.selectedId, '3'); assert.equal(focused, '3');
  key('ArrowUp'); assert.equal(session.selectedId, '1');
  assert.deepEqual(library.selection, ['0', '3', '1']);
  const count = opened.length;
  assert.equal(key('ArrowUp', {closest() {return null;}}), false, 'action controls retain their own keyboard handling');
  assert.equal(key('ArrowDown', cards[1], {altKey: true}), false);
  modal = true; assert.equal(key('ArrowDown'), false); modal = false;
  assert.equal(opened.length, count);
  click('1', true); assert.equal(session.selectedId, '3'); assert.deepEqual(library.selection, ['0', '3']);
  const catalogue = {...cards[4], inList: false}; catalogue.closest = selector => selector === '[data-chart-action]' ? null : catalogue;
  handlers.get('document:click')({target: catalogue, shiftKey: true});
  assert.deepEqual(library.selection, ['4']); assert.equal(session.selectedId, '4');
  click('4', true); assert.deepEqual(library.selection, []); assert.equal(key('ArrowDown'), false);
});


test('choosing clipped rows and opening actions reveals them by scrolling only the compact list', async () => {
  const {attachChartLibrary} = await import('../src/views/library.ts');
  const {createPanelState} = await import('../src/state/panels.ts');
  const handlers = new Map(), nodes = new Map();
  let expanded = false, cardTop = 170, scroll = 0, scale = 1, rowHeight = 52;
  const viewportTop = 100, viewportHeight = 180;
  function node(id) {
    if (!nodes.has(id)) nodes.set(id, {id, dataset: {}, classList: {toggle() {}}, setAttribute() {},
      contains(item) {return item === button || item === row || item === menu;}, focus() {},
      addEventListener(type, fn) {handlers.set(id + ':' + type, fn);}});
    return nodes.get(id);
  }
  const list = node('chartList'); list.clientHeight = viewportHeight;
  Object.defineProperty(list, 'scrollTop', {get: () => scroll, set: value => {scroll = Math.max(0, value);}});
  list.getBoundingClientRect = () => ({top: viewportTop, bottom: viewportTop + viewportHeight * scale, height: viewportHeight * scale});
  const bounds = (top, height) => ({top: viewportTop + (top - scroll) * scale,
    bottom: viewportTop + (top - scroll + height) * scale, height: height * scale});
  const row = {getBoundingClientRect: () => bounds(cardTop, expanded ? rowHeight + 54 : rowHeight),
    querySelector: () => expanded ? {getBoundingClientRect: () => bounds(cardTop + rowHeight, 54)} : null};
  const button = node('card'); button.dataset.chartId = '0';
  button.closest = selector => selector === '[data-chart-action]' ? null : selector === '.chart-row' ? row : button;
  const menu = {get open() {return expanded;}, set open(value) {expanded = value;},
    matches: () => expanded, closest: () => row, contains: () => false};
  const document = {getElementById: node, querySelector: () => null,
    querySelectorAll: selector => selector === '.chart-actions[open]' && expanded ? [menu] : [],
    addEventListener(type, fn) {handlers.set('document:' + type, fn);}};
  const panels = createPanelState(); panels.setLeft(true);
  const library = attachChartLibrary({getConnectionMode, subscribeConnection, document, panels, getCharts: () => charts(1), removeChart() {}, session: {selectedId: '0'},
    view: {update() {}, show() {}, hide() {}}, onNew() {}, onEdit() {}, onUpdate() {}, onSelect() {}});
  const click = () => handlers.get('document:click')({target: button, shiftKey: false});
  const fullyVisible = () => {const rect = row.getBoundingClientRect(), area = list.getBoundingClientRect();
    assert.ok(rect.top >= area.top + 6 * scale - .01, 'the top and focus ring are visible');
    assert.ok(rect.bottom <= area.bottom - 6 * scale + .01, 'the bottom and actions are visible');};
  click(); fullyVisible();
  const retained = scroll; click(); assert.equal(scroll, retained, 'a fully visible row does not jump');
  cardTop = 15; scroll = 35; click(); fullyVisible();
  cardTop = 130; scroll = 0; expanded = true;
  handlers.get('document:toggle')({target: menu}); fullyVisible();
  const openedScroll = scroll; expanded = false;
  handlers.get('document:toggle')({target: menu}); assert.equal(scroll, openedScroll, 'closing actions does not jump');
  scale = 1.5; cardTop = 165; scroll = 0; click(); fullyVisible();
  cardTop = 20; rowHeight = 170; expanded = true; scroll = 0;
  handlers.get('document:toggle')({target: menu});
  assert.ok(bounds(cardTop + rowHeight, 54).bottom <= list.getBoundingClientRect().bottom, 'if the whole row cannot fit, actions remain reachable');
  assert.equal(library.opened, true);
});


test('compact actions belong only to the displayed card, not every red row', () => {
  const h = harness(), saved = charts(4);
  h.view.update(saved, '2', ['0', '2']); h.view.show();
  const actions = h.children.map(row => row.querySelector('.chart-actions'));
  assert.deepEqual(actions.map(menu => menu.hidden), [true, true, false, true]);
  actions[2].open = true;
  h.view.update(saved, '0', ['0', '2']);
  assert.equal(actions[2].open, false, 'moving to another chart closes previous actions');
  assert.deepEqual(actions.map(menu => menu.hidden), [false, true, true, true]);
  h.view.update(saved, '0', []);
  assert.equal(actions[0].hidden, false, 'the displayed chart still has actions when its group is empty');
  h.view.update(saved, null, ['0', '2']);
  assert.ok(actions.every(menu => menu.hidden), 'a different workspace has no open chart actions');
});


test('a completed click switches charts before dismissing menus can move the pressed row', async () => {
  const {attachChartLibrary} = await import('../src/views/library.ts');
  const {createPanelState} = await import('../src/state/panels.ts');
  const nodes = new Map(), handlers = new Map(); const opened = [];
  let menuOpen = true, library;
  function node(id) {
    if (!nodes.has(id)) nodes.set(id, {dataset: {}, clientHeight: 300, scrollTop: 0,
      classList: {toggle() {}}, setAttribute() {}, addEventListener(type, fn) {handlers.set(id + ':' + type, fn);},
      contains(target) {return target === next;}, focus() {},
      getBoundingClientRect() {return {top: 0, bottom: id === 'chartList' ? 300 : 52, height: id === 'chartList' ? 300 : 52};}});
    return nodes.get(id);
  }
  const next = node('next'); next.dataset.chartId = '1';
  next.closest = selector => selector === '[data-chart-action]' ? null : next;
  const menu = {contains: () => false, get open() {return menuOpen;}, set open(value) {menuOpen = value;}};
  const document = {getElementById: node, querySelector: () => null,
    querySelectorAll: selector => selector === '.chart-actions[open]' && menuOpen ? [menu] : [],
    addEventListener(type, fn) {handlers.set('document:' + type, fn);}};
  const session = {selectedId: '0'}, panels = createPanelState(); panels.setLeft(true);
  library = attachChartLibrary({getConnectionMode, subscribeConnection, document, panels, session, getCharts: () => charts(2), removeChart() {},
    view: {update() {}, show() {}, hide() {}}, onNew() {}, onEdit() {}, onUpdate() {},
    onSelect(id) {opened.push(id); session.selectedId = id; library.render();}});
  // Collapsing details here moves the intended target before pointerup;
  // the browser then cannot dispatch the original card's click reliably.
  handlers.get('document:pointerdown')?.({target: next});
  assert.equal(menuOpen, true, 'the row must stay in place throughout the pointer press');
  assert.deepEqual(opened, [], 'pressing or starting a drag must not select a card');
  handlers.get('document:click')({target: next, shiftKey: false});
  assert.deepEqual(opened, ['1']); assert.equal(session.selectedId, '1');
  assert.equal(menuOpen, false, 'one click both selects the card and closes the previous actions');
  menuOpen = true;
  handlers.get('document:click')({target: {closest() {return null;}}});
  assert.equal(menuOpen, false, 'a completed outside click still dismisses actions');
});
