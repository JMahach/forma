import test from 'node:test';
import assert from 'node:assert/strict';
import * as feedback from '../src/ui/feedback.ts';
import { dateDom, type DateNode } from './helpers/date-dom.ts';

function harness() {
  assert.equal(typeof feedback.createActionNotice, 'function', 'anchored actions need one shared presentation owner');
  const document = dateDom();
  const create = document.createElement;
  document.createElement = tag => {
    const result = create(tag);
    const node: DateNode & Pick<HTMLElement,'removeAttribute'> = result;
    node.querySelectorAll = () => node.all(child => child.tagName === 'button');
    node.removeAttribute = name => node.setAttribute(name, '');
    node.getBoundingClientRect = () => ({left:0,top:0,right:248,bottom:88,width:248,height:88});
    return result;
  };
  const root = document.body, add: DateNode = document.createElement('button'), copy: DateNode = document.createElement('button');
  add.getBoundingClientRect = () => ({left:200,right:232,top:180,bottom:212,width:32,height:32});
  copy.getBoundingClientRect = () => ({left:150,right:182,top:180,bottom:212,width:32,height:32});
  root.append(add, copy);
  const notice = feedback.createActionNotice(root as unknown as HTMLElement);
  const panel = () => root.children.find(child => child.className.includes('action-notice'))!;
  const message = () => panel().children[0]?.textContent;
  return {document,root,add,copy,notice,panel,message};
}
const html=(node:DateNode)=>node as unknown as HTMLElement;
test('copy replaces waiting, without dismissing its action or leaving another live block', () => {
  const h=harness(); let cancelled=0;
  const wait=h.notice.show(html(h.add),{message:'waiting',busy:true},{onDismiss:()=>cancelled++});
  const copy=h.notice.show(html(h.copy),{message:'copied',tone:'success'});
  assert.equal(cancelled,0); assert.equal(wait.active,false); assert.equal(copy.active,true);
  assert.equal(h.root.children.filter(child=>child.className.includes('action-notice')).length,1);
  assert.equal(h.message(),'copied');
  wait.update({message:'late failure'}); wait.close();
  assert.equal(h.message(),'copied'); assert.equal(h.panel().hidden,false);
  assert.equal(feedback.createActionNotice(html(h.root)),h.notice);
});
test('an old success timeout cannot clear a newer waiting message', t => {
  t.mock.timers.enable({apis:['setTimeout']}); const h=harness(); let expired=0;
  h.notice.show(html(h.copy),{message:'copied'},{durationMs:2000,onExpire:()=>expired++});
  t.mock.timers.tick(1000);
  h.notice.show(html(h.add),{message:'waiting'});
  t.mock.timers.tick(2500);
  assert.equal(h.message(),'waiting'); assert.equal(h.panel().hidden,false); assert.equal(expired,0);
});
test('expiry can re-read current waiting state, never replay a saved old message', t => {
  t.mock.timers.enable({apis:['setTimeout']}); const h=harness(); let pending=true;
  const resume=()=>{if(pending) h.notice.show(html(h.add),{message:'current waiting'});};
  h.notice.show(html(h.copy),{message:'copied'},{durationMs:2000,onExpire:resume});
  t.mock.timers.tick(2000); assert.equal(h.message(),'current waiting');
  h.notice.show(html(h.copy),{message:'copied'},{durationMs:2000,onExpire:resume}); pending=false;
  t.mock.timers.tick(2000); assert.equal(h.panel().hidden,true);
});
test('Escape dismisses only the visible action and returns focus, without dismissing replaced waiting', () => {
  const h=harness(); let addDismissed=0,copyDismissed=0;
  h.notice.show(html(h.add),{message:'waiting'},{onDismiss:()=>addDismissed++});
  h.notice.show(html(h.copy),{message:'failed',actions:[{label:'retry',run:()=>{}}]},{onDismiss:()=>copyDismissed++});
  h.panel().all(node=>node.tagName==='button')[0].focus();
  h.document.dispatch('keydown',{key:'Escape'});
  assert.equal(copyDismissed,1); assert.equal(addDismissed,0); assert.equal(h.panel().hidden,true);
  assert.equal(h.document.activeElement,h.copy);
});
test('same message update retains focused action and invalidates its old callback', () => {
  const h=harness(); let calls=0;
  const entry=h.notice.show(html(h.add),{message:'waiting',actions:[{label:'cancel',run:()=>calls++}]});
  const old=h.panel().all(node=>node.tagName==='button')[0]; old.focus();
  entry.update({message:'offline',actions:[{label:'cancel',run:()=>calls++}]});
  old.dispatch('click'); assert.equal(calls,0);
  const current=h.panel().all(node=>node.tagName==='button')[0];
  assert.equal(h.document.activeElement,current); current.dispatch('click'); assert.equal(calls,1);
});
test('position prefers above and falls below when there is no room, staying in narrow bounds', () => {
  const h=harness();
  h.notice.show(html(h.add),{message:'waiting'});
  assert.equal(h.panel().dataset.side,'top'); assert.equal(h.panel().style.top,'84px');
  assert.equal(h.panel().style.left,'64px');
  h.add.getBoundingClientRect = () => ({left:280,right:312,top:20,bottom:52,width:32,height:32});
  h.document.defaultView.dispatch('resize');
  assert.equal(h.panel().dataset.side,'bottom'); assert.equal(h.panel().style.top,'60px');
  assert.equal(h.panel().style.left,'64px');
});

import * as shared from '../src/dev/shared-chart-preview.ts';
function chartMessages(h: ReturnType<typeof harness>, copyOutcome = () => 'success') {
  assert.equal(typeof shared.createSharedChartMessages,'function','both chart actions must use the shared surface');
  let messages: ReturnType<typeof shared.createSharedChartMessages>;
  const study=shared.createSharedChartStudy((...change)=>messages?.render(...change));
  messages=shared.createSharedChartMessages(h.notice,{
    add:html(h.add),copy:html(h.copy),getState:()=>study.state,copyOutcome,
    cancel:()=>study.cancel(),dismiss:()=>study.dismiss(),
  });
  return {study,messages};
}
test('a new add replaces either copy outcome immediately without cancelling it or losing the newer notice', t => {
  t.mock.timers.enable({apis:['setTimeout']});
  for (const outcome of ['success','error']) {
    const h=harness(),{study,messages}=chartMessages(h,()=>outcome);
    study.setConnection('server'); messages.copy();
    const copyText=h.message();
    t.mock.timers.tick(100);
    study.add();
    assert.equal(h.message(),'Сохраняем карту…','explicit add replaces copy without a local hide workaround');
    t.mock.timers.tick(2100);
    assert.equal(h.message(),'Сохраняем карту…','old copy expiry cannot hide the newer waiting notice');
    assert.equal(study.state.pending,true);
    messages.copy();
    assert.equal(h.message(),copyText);
    assert.equal(h.panel().all(node=>node.tagName==='button').length,0,'both copy outcomes use an icon, no action buttons');
    assert.equal(study.state.pending,true,'replacing the notice does not cancel the add');
    t.mock.timers.tick(1999);
    assert.equal(h.message(),copyText);
    t.mock.timers.tick(1);
    assert.equal(h.message(),'Сохраняем карту…','both outcomes expire at two seconds and retain the existing pending return');
    h.document.dispatch('keydown',{key:'Escape'});
    assert.equal(study.state.pending,false); assert.equal(h.panel().hidden,true);
  }
});
test('copy expiry restores live waiting, but completed add cannot close or replace current copy', t => {
  t.mock.timers.enable({apis:['setTimeout']});
  const h=harness(),{study,messages}=chartMessages(h);
  study.setConnection('server'); study.add(); messages.copy();
  t.mock.timers.tick(2000); assert.equal(h.message(),'Сохраняем карту…');
  messages.copy(); study.setConnection('online'); t.mock.timers.tick(750);
  assert.equal(study.state.kind,'saved'); assert.equal(h.message(),'Ссылка скопирована');
  t.mock.timers.tick(1250); assert.equal(h.panel().hidden,true);
});
test('leaving clears messages and cancellation prevents later restoration', t => {
  t.mock.timers.enable({apis:['setTimeout']});
  const h=harness(),{study,messages}=chartMessages(h);
  study.add(); messages.copy(); study.cancel(); messages.close();
  t.mock.timers.tick(3000); assert.equal(study.state.kind,'temporary'); assert.equal(h.panel().hidden,true);
});

test('a detached anchor leaves no description or expiry continuation behind', t => {
  t.mock.timers.enable({apis:['setTimeout']}); const h=harness(); let expired=0; h.add.remove();
  const entry=h.notice.show(html(h.add),{message:'waiting'},{durationMs:2000,onExpire:()=>expired++});
  assert.equal(entry.active,false); assert.equal(h.panel().hidden,true);
  assert.ok(!h.add.getAttribute('aria-describedby')); t.mock.timers.tick(2000); assert.equal(expired,0);
});
test('retry keeps focus on the replacement action, success returns it to its trigger', () => {
  const h=harness(); const first=h.notice.show(html(h.copy),{message:'failed',actions:[{label:'retry',run:()=>{}}]});
  h.panel().all(node=>node.tagName==='button')[0].focus();
  h.notice.show(html(h.copy),{message:'failed',actions:[{label:'retry',run:()=>{}}]});
  assert.equal(first.active,false); assert.equal(h.document.activeElement,h.panel().all(node=>node.tagName==='button')[0]);
  h.notice.show(html(h.copy),{message:'copied'}); assert.equal(h.document.activeElement,h.copy);
});

test('a connected but hidden trigger hides its notice and restores only when visible again', () => {
  const h=harness(); h.notice.show(html(h.add),{message:'waiting'}); h.add.hidden=true;
  h.document.defaultView.dispatch('resize');
  assert.equal(h.panel().hidden,true); assert.ok(!h.add.getAttribute('aria-describedby'));
  h.add.hidden=false; h.document.defaultView.dispatch('resize');
  assert.equal(h.panel().hidden,false); assert.equal(h.message(),'waiting');
  h.add.getBoundingClientRect=()=>({left:400,right:432,top:90,bottom:122,width:32,height:32});
  h.document.defaultView.dispatch('resize'); assert.equal(h.panel().hidden,true);
});

test('updating an active notice preserves other descriptions and restores its own relation', () => {
  const h=harness(); const entry=h.notice.show(html(h.add),{message:'waiting'});
  h.add.setAttribute('aria-describedby','offline-explanation'); entry.update({message:'offline'});
  assert.equal(h.add.getAttribute('aria-describedby'),`offline-explanation ${h.panel().id}`);
  entry.close(); assert.equal(h.add.getAttribute('aria-describedby'),'offline-explanation');
});
