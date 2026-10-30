import test from 'node:test';
import assert from 'node:assert/strict';
import { attachTimelineMarks } from '../src/views/timeline-marks.ts';
import { dateDom, type DateNode } from './helpers/date-dom.ts';

function harness(width = 640) {
  const document = dateDom(), container = document.createElement('div');
  let resize: (arg0: { target: DateNode&HTMLInputElement; contentRect: { width: number; }; }[]) => void;
  container.getBoundingClientRect = () => ({ width } as DOMRect);
  (document.defaultView as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    constructor(callback: (arg0: { target: DateNode&HTMLInputElement; contentRect: { width: number; }; }[]) => void) { resize = callback; }
    observe(target: unknown) { assert.equal(target, container); }
  };
  const marks = attachTimelineMarks(container);
  return { marks, container, resize(value: number) { width = value; resize([{ target: container, contentRect: { width } }]); } };
}
const fromUtc = Date.parse('2026-01-01T00:00:00Z'), toUtc = Date.parse('2026-12-31T23:59:59.999Z');

test('calendar return marks have exact endpoints and no new labels or interactions', () => {
  const h = harness(); h.marks.calendar({ fromUtc, toUtc, timeZone: 'UTC', labels: false });
  const nodes = h.container.children;
  assert.ok(nodes.length > 2 && nodes.length <= 24);
  assert.equal(nodes[0].style['--hour-position'], '0%');
  assert.equal(nodes.at(-1)!.style['--hour-position'], '100%');
  assert.ok(nodes.every(node => node.children.length === 0 && node.title === ''));
});

test('calendar marks resize without a range change and stop after switching mode', () => {
  const h = harness(900); h.marks.calendar({ fromUtc, toUtc, labels: false });
  const wide = h.container.children;
  h.marks.calendar({ fromUtc, toUtc, labels: false });
  assert.equal(h.container.children, wide, 'scrubbing keeps the currently rendered marks');
  h.resize(210); assert.ok(h.container.children.length < wide.length);
  assert.equal(h.container.children.at(-1)!.style['--hour-position'], '100%');
  h.marks.clear(); h.resize(900); assert.equal(h.container.children.length, 0);
});

test('only transit calendar mode adds sparse labels, without removing unlabelled ticks', () => {
  const h = harness(320);
  h.marks.calendar({ fromUtc, toUtc, labels: false }); const tickCount = h.container.children.length;
  h.marks.calendar({ fromUtc, toUtc, labels: true });
  assert.equal(h.container.children.length, tickCount);
  const labelled = h.container.children.filter(node => node.children.length);
  assert.deepEqual(labelled.map(mark => mark.children[0].textContent), ['янв', 'март', 'май', 'июль', 'сент', 'нояб']);
  h.marks.calendar({ fromUtc, toUtc, labels: false });
  assert.ok(h.container.children.every(node => node.children.length === 0));
});


const captions = (h: ReturnType<typeof harness>) => h.container.children.flatMap(mark => mark.children.map(label => label.textContent));

test('two years in a narrow chronicle show both January landmarks without duplicating the date fields', () => {
  const h = harness(342);
  h.marks.calendar({ fromUtc: Date.parse('2026-10-10T00:00:00Z'), toUtc: Date.parse('2028-10-10T23:59:59.999Z'), labels: true });
  assert.deepEqual(captions(h), ['2027', '2028']);
  assert.equal(h.container.children[0].children.length, 0);
  assert.equal(h.container.children.at(-1)!.children.length, 0);
});

test('three months show every readable month boundary rather than a single middle caption', () => {
  const h = harness(342);
  h.marks.calendar({ fromUtc: Date.parse('2026-10-10T00:00:00Z'), toUtc: Date.parse('2027-01-10T23:59:59.999Z'), labels: true });
  assert.deepEqual(captions(h), ['нояб', 'дек', 'янв']);
});

test('an exact edge is captioned only when it belongs to the same calendar step and phase', () => {
  const h = harness(342);
  h.marks.calendar({ fromUtc: Date.parse('1998-01-01T00:00:00Z'), toUtc: Date.parse('2028-01-01T23:59:59.999Z'), labels: true });
  assert.deepEqual(captions(h), ['2000', '2005', '2010', '2015', '2020', '2025']);
  assert.equal(h.container.children[0].children.length, 0, '1998 is not a five-year boundary');
  h.marks.calendar({ fromUtc: Date.parse('2026-01-01T00:00:00Z'), toUtc: Date.parse('2028-10-10T23:59:59.999Z'), labels: true });
  assert.deepEqual(captions(h), ['2026', '2027', '2028']);
});

test('dense labels use one regular calendar stride and remain inside the rail', () => {
  const h = harness(900);
  h.marks.calendar({ fromUtc: Date.parse('1900-01-01T00:00:00Z'), toUtc: Date.parse('2000-01-01T00:00:00Z'), labels: true });
  const labels = captions(h).map(Number);
  assert.ok(labels.length >= 3 && labels.length <= 8);
  const step = labels[1] - labels[0];
  assert.ok(step > 0);
  for (let index = 2; index < labels.length; index++) assert.equal(labels[index] - labels[index - 1], step);
  let right = -Infinity;
  for (const mark of h.container.children.filter(mark => mark.children.length)) {
    const length = mark.children[0].textContent.length * 6;
    const position = Number.parseFloat(mark.style['--hour-position'] as string) / 100 * 900;
    const left = mark.dataset.edge === 'start' ? 0 : mark.dataset.edge === 'end' ? 900 - length : position - length / 2;
    assert.ok(left >= 0 && left + length <= 900);
    assert.ok(left >= right + 14);
    right = left + length;
  }
});

test('a short interval without calendar boundaries retains one truthful time caption', () => {
  const h = harness(342);
  h.marks.calendar({ fromUtc: Date.parse('2026-10-10T12:03:00Z'), toUtc: Date.parse('2026-10-10T12:07:00Z'), labels: true });
  assert.deepEqual(captions(h), ['12:03']);
  assert.equal(h.container.children.length, 2);
  assert.equal(h.container.children[0].style['--hour-position'], '0%');
});

test('a skipped calendar date does not introduce an off-grid caption', () => {
  const h = harness(342);
  h.marks.calendar({ fromUtc: Date.parse('2011-12-29T10:00:00Z'), toUtc: Date.parse('2012-01-04T09:59:59.999Z'), timeZone: 'Pacific/Apia', labels: true });
  assert.deepEqual(captions(h), ['01.01', '03.01']);
  assert.equal(h.container.children.length, 5, 'unlabelled ticks remain on the rail');
});


test('timeline marks retire observation and stale methods across thirty lifetimes while a neighbor stays live',()=>{
  const document=dateDom(),container=document.createElement('div');let reads=0,writes=0;
  container.getBoundingClientRect=()=>{reads++;return {width:640} as DOMRect;};
  const replace=container.replaceChildren.bind(container);
  container.replaceChildren=(...nodes)=>{writes++;replace(...nodes);};
  const observers:{active:boolean;callback:ResizeObserverCallback}[]=[];
  class Observer {
    active=false;callback:ResizeObserverCallback;
    constructor(callback:ResizeObserverCallback){this.callback=callback;observers.push(this);}
    observe(){this.active=true;} disconnect(){this.active=false;}
  }
  Object.assign(document.defaultView,{ResizeObserver:Observer});
  const neighborSignal=new AbortController(),neighbor=attachTimelineMarks(container,neighborSignal.signal);
  for(let cycle=0;cycle<30;cycle++){
    const controller=new AbortController(),marks=attachTimelineMarks(container,controller.signal);
    marks.calendar({fromUtc,toUtc});assert.equal(observers.filter(o=>o.active).length,2);
    controller.abort();controller.abort();assert.equal(observers.filter(o=>o.active).length,1);
    const before={reads,writes},nodes=container.children;
    const stale=observers.at(-1)!;
    stale.callback([{get target(){reads++;return container;},contentRect:{width:200}} as unknown as ResizeObserverEntry],{} as ResizeObserver);
    marks.clear();marks.calendar({fromUtc:0,toUtc:100});
    marks.day({},2,()=>{throw Error('stale day computation');});marks.life({get utc(){throw Error('stale life computation');}} as never,0,100);
    assert.deepEqual({reads,writes},before);assert.equal(container.children,nodes);
    neighbor.calendar({fromUtc:fromUtc+cycle+1,toUtc});assert.ok(writes>before.writes,'live neighboring owner still updates');
  }
  neighborSignal.abort();assert.equal(observers.filter(o=>o.active).length,0);
  const stopped=new AbortController();stopped.abort();const count=observers.length,before={reads,writes};
  const marks=attachTimelineMarks(container,stopped.signal);marks.calendar({fromUtc,toUtc});marks.clear();
  assert.equal(observers.length,count);assert.deepEqual({reads,writes},before);
});

test('late marks resize cannot update retained calendar after abort',()=>{
  const document=dateDom(),container=document.createElement('div');let callback!:ResizeObserverCallback,reads=0;
  container.getBoundingClientRect=()=>({width:640} as DOMRect);
  Object.assign(document.defaultView,{ResizeObserver:class {constructor(cb:ResizeObserverCallback){callback=cb;}observe(){}disconnect(){}}});
  const controller=new AbortController(),marks=attachTimelineMarks(container,controller.signal);marks.calendar({fromUtc,toUtc});
  controller.abort();const children=container.children;
  callback([{get target(){reads++;return container;},contentRect:{width:200}} as unknown as ResizeObserverEntry],{} as ResizeObserver);
  assert.equal(reads,0);assert.equal(container.children,children);
});
