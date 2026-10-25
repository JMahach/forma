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
 const {createStandConnection}=await import('../src/dev/stand-connection.ts');
 const {configureTransportSimulation}=await import('../src/data/http-transport.ts');
 const {renderChartLibraryRow}=await import('../src/views/library.ts');
 const connection=createStandConnection();configureTransportSimulation(connection);t.after(()=>configureTransportSimulation(null));
 for(const mode of ['offline','server','online'] as const){
  connection.set(mode);
  for(const preview of [false,true]){
   const html=renderChartLibraryRow(charts(1)[0],false,{preview});
   const edit=html.match(/<button[^>]*data-chart-action="edit"[^>]*>/)![0];
   assert.equal(/\bdisabled\b/.test(edit),mode==='offline');
   assert.doesNotMatch(html.match(/<button class="chart-card"[^>]*>/)![0],/disabled/);
   assert.doesNotMatch(html.match(/<button[^>]*data-chart-action="delete"[^>]*>/)![0],/disabled/,'current deletion is local, not a server write');
  }
 }
});
test('live connection changes update New and every Edit without resetting the list or bypassing guards', async t=>{
 const {attachChartLibrary}=await import('../src/views/library.ts');
 const {createStandConnection}=await import('../src/dev/stand-connection.ts');
 const {configureTransportSimulation}=await import('../src/data/http-transport.ts');
 const connection=createStandConnection();configureTransportSimulation(connection);t.after(()=>configureTransportSimulation(null));
 const nodes=new Map(), handlers=new Map();let newCalls=0,editCalls=0;
 function node(id){if(!nodes.has(id))nodes.set(id,{id,disabled:false,dataset:{},classList:{toggle(){}},setAttribute(){},contains(){return false;},focus(){},addEventListener(type,fn){handlers.set(id+':'+type,fn);}});return nodes.get(id);}
 const edits=[node('menuEdit'),node('catalogEdit')];for(const edit of edits){edit.dataset={chartAction:'edit',actionChartId:'0'};edit.closest=selector=>selector==='[data-chart-action]'?edit:{open:true};}
 const document={getElementById:node,querySelectorAll:selector=>selector==='[data-chart-action="edit"]'?edits:[],querySelector:()=>null,addEventListener(type,fn){handlers.set('document:'+type,fn);}};
 attachChartLibrary({document,store:{charts:charts(1)},session:{selectedId:'0'},view:{update(){},show(){},hide(){}},onNew(){newCalls++;},onEdit(){editCalls++;},onSelect(){}});
 connection.set('offline');assert.equal(node('newChartButton').disabled,true);assert.ok(edits.every(x=>x.disabled));
 handlers.get('newChartButton:click')();handlers.get('document:click')({target:edits[0]});assert.equal(newCalls,0);assert.equal(editCalls,0);
 connection.set('server');assert.equal(node('newChartButton').disabled,false);assert.ok(edits.every(x=>!x.disabled));
 handlers.get('newChartButton:click')();handlers.get('document:click')({target:edits[1]});assert.equal(newCalls,1);assert.equal(editCalls,1);
});
