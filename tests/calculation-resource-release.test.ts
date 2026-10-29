import test from 'node:test';
import assert from 'node:assert/strict';
import { createNatalDayExplorer } from '../src/state/natal-day.ts';
import { createLiveTransit } from '../src/state/live-transit.ts';
import { createReturnsController } from './fixtures/returns.ts';
import { createLifetimeExplorer } from './fixtures/lifetime.ts';
import { natalDayFixture, personalChartFixture, libraryRecordAtMinute } from './fixtures/natal-day.ts';

const day=natalDayFixture(), record=libraryRecordAtMinute(day,0,personalChartFixture());
test('incompatible natal Day releases its packet once without resetting the selected minute or open mode',async()=>{
 let released=0;
 const control=createNatalDayExplorer({dayClient:{getDay:async()=>day,retainDay:()=>()=>released++}});
 control.select(record);await control.open();control.scrub(90);const before=control.state;
 control.invalidateCalculations();assert.equal(released,1);assert.equal(control.state.day,null);
 assert.equal(control.state.index,before.index);assert.equal(control.state.opened,true);
 assert.equal(control.state.current?.utc,before.current?.utc);control.close();assert.equal(released,1);
});
test('incompatible live Transit releases packets once while preserving its paused timeline target',async()=>{
 let released=0;
 const control=createLiveTransit({now:()=>Date.parse(`${day.date}T12:00:00Z`),timeZone:()=> 'UTC',dayClient:{getDay:async()=>day,retainDay:()=>()=>released++}});
 await control.start();control.scrub(90);const before=control.state;
 control.invalidateCalculations();assert.equal(released,1);assert.equal(control.current,null);
 assert.equal(control.state.index,before.index);assert.equal(control.state.timeline,before.timeline);assert.equal(control.state.live,false);
 control.stop();assert.equal(released,1);
});
test('incompatible exact Return releases its chart and event inputs once while preserving natal, filter and exact event',async()=>{
 let chartReleased=0,eventReleased=0;
 const event=(body:string)=>({id:`${body}:2028-07-21T12:36:05Z`,body,utc:'2028-07-21T12:36:05Z',age:1,cycle:1,pass:1,cycleId:`${body}:1`,direction:'direct' as const});
 const control=createReturnsController({client:{events:async input=>({events:[event(input.body)],range:{fromAge:input.fromAge!,toAge:input.toAge!}}),chart:async()=>({chart:record}),retainChart:()=>()=>chartReleased++,retainEvents:()=>()=>eventReleased++}});
 await control.select(record);await control.open();await control.selectEvent(event('saturn').id);const before=control.state;
 control.invalidateCalculations();assert.equal(chartReleased,1);assert.equal(eventReleased,before.readyBodies.length);
 assert.equal(control.current,null);assert.equal(control.state.natal,record);assert.equal(control.state.opened,true);
 assert.equal(control.state.selectedEvent,before.selectedEvent);assert.deepEqual(control.state.bodies,before.bodies);
 control.exit();assert.equal(chartReleased,1);
});
test('incompatible Lifetime drops its borrowed numerical result while preserving the requested UTC and mode',async()=>{
 const control=createLifetimeExplorer({getDayState:()=>({current:record,timeline:{date:day.date}})});
 await control.open();const before=control.state;assert.ok(before.current);
 control.invalidateCalculations();assert.equal(control.current,null);assert.equal(control.state.displayedUtc,null);
 assert.equal(control.state.requestedUtc,before.requestedUtc);assert.equal(control.state.mode,before.mode);assert.equal(control.state.opened,true);
 control.close();
});
