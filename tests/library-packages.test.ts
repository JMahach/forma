import test from 'node:test';
import assert from 'node:assert/strict';
import {cardSourceKey,natalDaySourceKey,returnSourceKey,validMajorReturnsPackage,
  type MajorReturnsPackage,type PackageRef} from '../shared/library-package-contract.ts';
import {cycleAge} from '../shared/cycles-format.ts';
import {mainReturnRange} from '../shared/chart-return-contract.ts';
import {accountNatalChart} from './helpers/account-chart.ts';

function family() {
  const source={birthUtc:'2000-01-01T12:00:00.123456Z',timezone:'UTC'},body='saturn';
  const ref:Extract<PackageRef,{kind:'major-returns'}>={kind:'major-returns',sourceKey:returnSourceKey(source),family:body};
  const events=['2029-01-01T12:00:00.123456Z','2058-01-01T12:00:00.123456Z'].map((utc,index)=>({
    utc,body,id:`${body}:${utc}`,age:cycleAge(utc,source.birthUtc),cycle:index+1,cycleId:`${body}:${index+1}`,pass:1,direction:'direct' as const,
  }));
  const value:MajorReturnsPackage={source,family:body,dates:{range:mainReturnRange(source.birthUtc)!,events},
    charts:events.map(event=>({chart:{...accountNatalChart(),source:'calculated',timezone:source.timezone,utc:event.utc,
      designUtc:'2028-10-01T12:00:00Z',designArcResidualDegrees:1e-9}}))};
  return {ref,value};
}

test('package references distinguish record edits, shared civil days and exact birth instants',()=>{
  const card=accountNatalChart();
  assert.notEqual(cardSourceKey(card),cardSourceKey({...card,revision:card.revision+1}));
  assert.equal(natalDaySourceKey({date:card.birthDate,timezone:'UTC'}),natalDaySourceKey({date:card.birthDate,timezone:'UTC'}));
  assert.notEqual(natalDaySourceKey({date:card.birthDate,timezone:'UTC'}),natalDaySourceKey({date:card.birthDate,timezone:'Europe/Moscow'}));
  assert.notEqual(returnSourceKey({birthUtc:'2000-01-01T12:00:00.123456Z',timezone:'UTC'}),
    returnSourceKey({birthUtc:'2000-01-01T12:00:00.123457Z',timezone:'UTC'}),'sub-millisecond source digits survive');
});

test('complete family validation preserves every numerical value and permits a confirmed empty family',()=>{
  const {ref,value}=family();
  value.charts[0]!.chart.activations.personality[0]!.longitude=-0;
  value.charts[0]!.chart.activations.personality[1]!.longitude=Number.MIN_VALUE;
  const before=structuredClone(value);
  assert.equal(validMajorReturnsPackage(ref,value),true);assert.deepEqual(value,before);
  value.dates.events=[];value.charts=[];assert.equal(validMajorReturnsPackage(ref,value),true);
});

test('missing, duplicate, shifted or invalid events never constitute a whole family',()=>{
  const {ref,value}=family();
  const invalid:unknown[]=[null,{}, {...value,charts:value.charts.slice(0,1)},
    {...value,charts:new Array(value.charts.length)},
    {...value,dates:{...value.dates,events:new Array(value.charts.length)}},
    {...value,charts:[value.charts[0],value.charts[0]]}, {...value,charts:[...value.charts].reverse()},
    {...value,charts:[...value.charts,value.charts[0]]},
    {...value,dates:{...value.dates,range:{fromAge:0,toAge:10}}},
    {...value,source:{...value.source,birthUtc:'2000-01-01T12:00:00.123457Z'}},
    {...value,source:{...value.source,timezone:'Europe/Moscow'}}, {...value,family:'moon'},
    {...value,charts:[{},value.charts[1]]}];
  for(const candidate of invalid)assert.equal(validMajorReturnsPackage(ref,candidate),false);
  const changed=structuredClone(value);changed.charts[0]!.chart.utc='2029-01-01T12:00:00.123457Z';
  assert.equal(validMajorReturnsPackage(ref,changed),false,'a nearby root is not the manifest event');
  changed.charts[0]!.chart.utc=value.charts[0]!.chart.utc;changed.charts[0]!.chart.designUtc=changed.charts[0]!.chart.utc;
  assert.equal(validMajorReturnsPackage(ref,changed),false);
});
