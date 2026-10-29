import test from 'node:test';
import assert from 'node:assert/strict';
import { attachLiveTransit } from '../src/views/live-transit.ts';
import { createNatalDayExplorer } from '../src/state/natal-day.ts';
import { natalDayFixture, personalChartFixture, libraryRecordAtMinute } from './fixtures/natal-day.ts';
import type { TransitDay } from '../shared/day-packets/transit-format.ts';

const settle=async()=>{for(let i=0;i<12;i++)await Promise.resolve();};
function fixture({visible=true,load}:{visible?:boolean;load?:(date:string,signal?:AbortSignal)=>Promise<TransitDay>}={}) {
 let chartVisible=visible,now=Date.parse('2026-09-24T12:00:20Z'),reads=0,renders=0,notices=0;
 const requests:string[]=[],document=Object.assign(new EventTarget(),{hidden:false});
 const packet=(date:string)=>{const day=natalDayFixture({date});return {...day,columns:day.columns.map(column=>new Proxy(column,{get(target,key){
  if(typeof key==='string' && /^\d+$/.test(key))reads++;return Reflect.get(target,key,target);
 }}))} as TransitDay;};
 const control=attachLiveTransit({document:document as unknown as Document,button:{setAttribute(){},removeAttribute(){},title:''} as unknown as HTMLButtonElement,
  isChartVisible:()=>chartVisible,now:()=>now,timeZone:()=> 'UTC',
  dayClient:{getDay(date,{signal}={}){requests.push(date);return load?load(date,signal):Promise.resolve(packet(date));}},
  onRender(){renders++;},onStateChange(){notices++;}});
 return {control,document,requests,packet,get reads(){return reads;},get renders(){return renders;},get notices(){return notices;},
  set visible(value:boolean){chartVisible=value;},advance(ms:number){now+=ms;},get now(){return now;}};
}

test('a hidden workspace starts no live packet, timer or moment until the chart becomes visible',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});const f=fixture({visible:false});t.after(()=>f.control.stop());
 assert.equal(await f.control.start(null,{firstChart:true}),false);const notices=f.notices;
 f.advance(3*86400000);t.mock.timers.tick(3*86400000);await settle();
 assert.deepEqual(f.requests,[]);assert.equal(f.reads,0);assert.equal(f.renders,0);assert.equal(f.notices,notices);
 f.visible=true;f.control.visibilityChanged();await settle();
 assert.deepEqual(f.requests,['2026-09-27']);assert.equal(f.control.current?.utc,'2026-09-27T12:00:00Z');assert.equal(f.renders,1);
});

test('leaving the chart suspends minute preparation and returning publishes the current ready minute immediately',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});const f=fixture();t.after(()=>f.control.stop());await f.control.start();
 const chart=f.control.current,reads=f.reads,renders=f.renders,notices=f.notices;
 f.visible=false;f.control.visibilityChanged();f.advance(10*60000);t.mock.timers.tick(10*60000);await settle();
 assert.equal(f.control.current,chart);assert.equal(f.reads,reads);assert.equal(f.renders,renders);assert.equal(f.notices,notices);assert.equal(f.requests.length,1);
 // Other owners may emit a metadata/reference refresh while the chart is hidden.
 await f.control.refresh();f.control.setWanted(true);await settle();
 assert.equal(f.reads,reads);assert.equal(f.renders,renders);assert.equal(f.requests.length,1);
 f.visible=true;f.control.visibilityChanged();
 assert.equal(f.control.current?.utc,'2026-09-24T12:10:00Z','a ready current minute publishes in the visibility command');
 assert.equal(f.reads,reads+24);assert.equal(f.renders,renders+1);assert.equal(f.requests.length,1);
});

test('a workspace return preserves a paused minute and resumes the reference clock without rereading that moment',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});const f=fixture();t.after(()=>f.control.stop());
 await f.control.start({live:false,date:'2026-09-24',timeZone:'UTC',index:12});const chart=f.control.current,reads=f.reads;
 f.visible=false;f.control.visibilityChanged();f.advance(20*60000);t.mock.timers.tick(20*60000);await settle();
 f.visible=true;f.control.visibilityChanged();
 assert.equal(f.control.current,chart);assert.equal(f.control.state.index,12);assert.equal(f.control.state.live,false);assert.equal(f.reads,reads);
 assert.equal(f.control.state.referenceIndex,740);assert.equal(f.requests.length,1);
});

test('midnight while another workspace is open waits until return before requesting and publishing the new day',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});const f=fixture();t.after(()=>f.control.stop());await f.control.start();
 const shown=f.control.current,reads=f.reads;f.visible=false;f.control.visibilityChanged();
 f.advance(2*86400000);t.mock.timers.tick(2*86400000);await settle();
 assert.equal(f.requests.length,1);assert.equal(f.reads,reads);assert.equal(f.control.current,shown);assert.equal(f.control.state.referenceIndex,null);
 f.visible=true;f.control.visibilityChanged();await settle();
 assert.deepEqual(f.requests,['2026-09-24','2026-09-26']);assert.equal(f.control.current?.utc,'2026-09-26T12:00:00Z');assert.equal(f.control.state.live,true);
});

test('hiding a workspace preserves an in-flight shared day and accepts its packet without preparing a hidden moment',async t=>{
 let finish!:(day:TransitDay)=>void,signal:AbortSignal|undefined;
 const f=fixture({load:(_date,owned)=>{signal=owned;return new Promise(resolve=>{finish=resolve;});}});t.after(()=>f.control.stop());
 const waiting=f.control.start();f.visible=false;f.control.visibilityChanged();
 assert.equal(signal?.aborted,false,'the existing day/file consumers retain their physical request');
 finish(f.packet('2026-09-24'));await waiting;assert.equal(f.reads,0);assert.equal(f.renders,0);assert.equal(f.requests.length,1);
 f.advance(60000);f.visible=true;f.control.visibilityChanged();
 assert.equal(f.control.current?.utc,'2026-09-24T12:01:00Z');assert.equal(f.reads,24);assert.equal(f.requests.length,1);
});

test('a metadata-only Day update can notify its consumers without preparing a hidden live moment',async t=>{
 const f=fixture();t.after(()=>f.control.stop());await f.control.start();f.visible=false;f.control.visibilityChanged();f.advance(60000);
 const reads=f.reads,renders=f.renders,day=natalDayFixture(),record=libraryRecordAtMinute(day,0,personalChartFixture());
 let natalRenders=0;
 const natal=createNatalDayExplorer({dayClient:{getDay:async()=>day},onStateChange(){void f.control.refresh();},onRender(){natalRenders++;}});
 natal.select(record);const renamed={...record,name:'Новое имя'};natal.updateMetadata(renamed);await settle();
 assert.equal(natal.state.original,renamed);assert.equal(natalRenders,0);assert.equal(f.reads,reads);assert.equal(f.renders,renders);assert.equal(f.requests.length,1);
});
