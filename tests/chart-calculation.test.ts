import { createCalculationReceipts } from '../server/services/calculation-receipt.ts';
import { createHmac } from 'node:crypto';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createChartCalculation } from '../server/services/chart-calculation.ts';
import { createCityCatalog } from '../server/services/cities.ts';
import type { ChartRecord, CalculationRequest, CalculationError } from '../shared/chart-types.ts';

const city={id:'1',name:'Test City',aliases:['Test City'],country:'Test',region:'',timezone:'UTC',latitude:0,longitude:0};
const planets=['sun','earth','moon','north_node','south_node','mercury','venus','mars','jupiter','saturn','uranus','neptune','pluto'];
function calculated(source:'calculated'|'transit'='calculated'):ChartRecord {
  const side=planets.map((planet,index)=>({planet,longitude:index*20,gate:index+1,line:1,color:99}));
  return {source,id:null,name:'Untrusted worker name',note:'must not be stored',createdAt:'ignored',updatedAt:'ignored',
    birthDate:'2000-01-01',birthTime:'12:00',birthPlace:'Test City',utc:'2000-01-01T12:00:00Z',timezone:'UTC',
    utcOffset:'UTC+00:00',fold:0,designUtc:'1999-10-10T01:00:00Z',designArcResidualDegrees:1e-9,
    personality:side.map(a=>a.gate),design:side.map(a=>a.gate),activations:{personality:side,design:side},
    engine:'test',ephemeris:'test',timezoneDatabase:'test',nodeModel:'true',zodiac:'test',verification:'test'};
}
const natal={source:'calculated',date:'2000-01-01',time:'12:00',cityId:'1'};
function setup(output:{chart:ChartRecord;timeResolution?:{ambiguous:boolean}}|CalculationError={chart:calculated()}) {
  const requests:CalculationRequest[]=[];
  const prepare=createChartCalculation({cities:createCityCatalog([city]),calculate:async input=>{requests.push(input);return structuredClone('chart' in output && !Object.hasOwn(output,'timeResolution') ? {...output,timeResolution:{ambiguous:false}} : output);}});
  return {prepare,requests,options:{signal:new AbortController().signal}};
}
test('prepared births use catalog and server metadata and drop unrelated worker fields',async()=>{
  const f=setup(),birth=await f.prepare(natal,f.options);
  assert.equal(f.requests[0]!.city!.timezone,'UTC'); assert.equal(f.requests[0]!.mode,'natal');
  assert.equal(Object.hasOwn(birth,'calculationVersion'),false); assert.equal(birth.cityId,'1');
  assert.equal(birth.birthPlace,'Test City'); assert.equal('name' in birth,false); assert.equal('note' in birth,false);
  assert.equal('createdAt' in birth,false); assert.equal('color' in birth.activations.personality[0]!,false);
});
test('client calculated numbers, timezone and internal modes are rejected before the worker',async()=>{
  const f=setup();
  for(const value of [{...natal,activations:{}},{...natal,timezone:'Other'},{...natal,fold:true},
    {...natal,city:{timezone:'Other'}},{...natal,cityId:'missing'},{source:'transit_moment',utc:'2000-01-01T12:00:00Z'}]) {
    await assert.rejects(f.prepare(value,f.options));
  }
  assert.equal(f.requests.length,0);
});
test('full stored transit retains exact UTC and requires both complete sides',async()=>{
  const chart=calculated('transit');chart.utc='2000-01-01T12:00:32.789Z';
  const f=setup({chart});const birth=await f.prepare({source:'transit',utc:chart.utc},f.options);
  assert.equal(birth.utc,chart.utc); assert.equal(birth.activations.design.length,13); assert.ok(birth.designUtc);
  const incomplete=structuredClone(chart);incomplete.activations!.design=[];incomplete.design=[];
  const g=setup({chart:incomplete});
  await assert.rejects(g.prepare({source:'transit',utc:chart.utc},g.options),{code:'invalid_calculation'});
  const shifted=setup({chart:{...chart,utc:'2000-01-01T12:00:32Z'}});
  await assert.rejects(shifted.prepare({source:'transit',utc:chart.utc},shifted.options),{code:'invalid_calculation'});
});
test('a malformed successful worker response cannot become stored chart data',async()=>{
  for(const mutate of [
    (c:ChartRecord)=>{c.designArcResidualDegrees=NaN;},(c:ChartRecord)=>{c.designUtc='not a date';},
    (c:ChartRecord)=>{c.timezone='Other';},(c:ChartRecord)=>{c.birthDate='2000-02-01';},
    (c:ChartRecord)=>{c.activations!.personality[0]!.line=7;},(c:ChartRecord)=>{c.personality=[64];},
    (c:ChartRecord)=>{c.utc='2000-02-30T12:00:00Z';}
  ]) {
    const chart=calculated();mutate(chart);const f=setup({chart});
    await assert.rejects(f.prepare(natal,f.options),{code:'invalid_calculation'});
  }
});
test('calculator refusals keep their reason and the ambiguity choices instead of becoming a server failure',async()=>{
  const choices=[{fold:0,utc:'2000-01-01T12:00:00Z',label:'UTC+00:00'},{fold:1,utc:'2000-01-01T13:00:00Z',label:'UTC−01:00'}];
  const f=setup({error:'ambiguous_time',message:'Choose offset',choices});
  await assert.rejects(f.prepare(natal,f.options),error=>{
    assert.equal((error as {code:string}).code,'ambiguous_time');
    assert.deepEqual((error as {payload:unknown}).payload,{error:'ambiguous_time',message:'Choose offset',choices});return true;
  });
  const busy=setup({error:'busy',message:'Busy'});
  await assert.rejects(busy.prepare(natal,busy.options),{code:'busy',status:503});
});

test('an explicitly selected ambiguous fold cannot silently change in the prepared result',async()=>{
  const f=setup({chart:calculated(),timeResolution:{ambiguous:true}});
  await assert.rejects(f.prepare({...natal,fold:1},f.options),{code:'invalid_calculation',status:503});
});
test('malformed ambiguity choices are a bad worker result, not a bad user request',async()=>{
  const f=setup({error:'ambiguous_time',message:'Choose offset',choices:[null,{fold:1,utc:'2000-01-01T12:00:00Z',label:'UTC'}]});
  await assert.rejects(f.prepare(natal,f.options),{code:'invalid_calculation',status:503});
});

test('the civil owner permits unambiguous fold normalization and its proof is required',async()=>{
  const f=setup();
  assert.equal((await f.prepare({...natal,fold:1},f.options)).fold,0);
  const missing=setup({chart:calculated(),timeResolution:undefined});
  await assert.rejects(missing.prepare(natal,missing.options),{code:'invalid_calculation',status:503});
  const chart=calculated();chart.fold=1;
  const ambiguous=setup({chart,timeResolution:{ambiguous:true}});
  assert.equal((await ambiguous.prepare({...natal,fold:1},ambiguous.options)).fold,1);
  await assert.rejects(ambiguous.prepare(natal,ambiguous.options),{code:'invalid_calculation'});
});

test('one invalid result emits one safe failure while transport and input failures do not duplicate it',async()=>{
 let calls=0;
 const prepare=createChartCalculation({cities:createCityCatalog([city]),calculate:async()=>({chart:calculated(),timeResolution:{ambiguous:false}}),
  onInvalidResult:()=>{calls++;}});
 const bad=createChartCalculation({cities:createCityCatalog([city]),calculate:async()=>({chart:{...calculated(),personality:[]},timeResolution:{ambiguous:false}}),
  onInvalidResult:()=>{calls++;}});
 const rejected=createChartCalculation({cities:createCityCatalog([city]),calculate:async()=>{throw Error('process failed');},onInvalidResult:()=>{calls++;}});
 const signal=new AbortController().signal;
 await prepare(natal,{signal});assert.equal(calls,0);
 await assert.rejects(bad(natal,{signal}),{code:'invalid_calculation'});assert.equal(calls,1);
 await assert.rejects(prepare({...natal,cityId:'missing'},{signal}),{code:'city_required'});assert.equal(calls,1);
 await assert.rejects(rejected(natal,{signal}),/process failed/);assert.equal(calls,1);
});
test('a failing diagnostic callback never replaces the invalid result failure',async()=>{
 const bad=createChartCalculation({cities:createCityCatalog([city]),calculate:async()=>({chart:{...calculated(),personality:[]},timeResolution:{ambiguous:false}}),
  onInvalidResult:()=>Promise.reject(Error('journal unavailable'))});
 await assert.rejects(bad(natal,{signal:new AbortController().signal}),{code:'invalid_calculation'});
});


test('saving a signed ready calculation validates the same birth without another worker call',async()=>{
  const receipts=createCalculationReceipts({key:Buffer.alloc(32,7)});
  let calls=0,token='';
  const prepare=createChartCalculation({cities:createCityCatalog([city]),receipts,
    calculate:async request=>{calls++;const result={chart:calculated(),timeResolution:{ambiguous:false}};
      token=receipts.issue(request,result)!;return result;}});
  const signal=new AbortController().signal;
  const first=await prepare(natal,{signal});
  assert.deepEqual(await prepare({...natal,fold:0},{signal,receipt:token}),first);
  assert.equal(calls,1);
  const payload=JSON.parse(Buffer.from(token.split('.')[0]!,'base64url').toString());
  assert.equal(Object.hasOwn(payload,'version'),false);
  assert.equal(payload.result.chart.name,'');assert.equal(payload.result.chart.note,'');
  for(const receipt of [token+'x',token.slice(0,-1)+(token.endsWith('a')?'b':'a'),'bad', 'a'.repeat(16001)]){
    await assert.rejects(prepare(natal,{signal,receipt}),{code:'invalid_request'});
  }
  await assert.rejects(prepare({...natal,date:'2000-01-02'},{signal,receipt:token}),{code:'invalid_request'});
  assert.equal(calls,1,'Invalid receipts do not fall back to expensive work');
});

test('calculation receipts bind the server key and exact input; a signed legacy field never causes recalculation',async()=>{
  const key=Buffer.alloc(32,7),current=createCalculationReceipts({key});
  const request:CalculationRequest={mode:'natal',date:'2000-01-01',time:'12:00',city};
  const result={chart:calculated(),timeResolution:{ambiguous:false}},issued=current.issue(request,result)!;
  const contents=JSON.parse(Buffer.from(issued.split('.')[0]!,'base64url').toString());
  const payload=Buffer.from(JSON.stringify({...contents,version:'historical-calculation-marker'})).toString('base64url');
  const receipt=payload+'.'+createHmac('sha256',key).update('forma:calculation-receipt:v1\0').update(payload).digest('base64url');
  assert.deepEqual(current.read(receipt,request),current.read(issued,request));
  const prepare=createChartCalculation({cities:createCityCatalog([city]),receipts:current,
    calculate:async()=>{throw Error('A ready signed calculation must not be calculated again');}});
  const restored=await prepare(natal,{signal:new AbortController().signal,receipt});
  assert.deepEqual(restored.activations,contents.result.chart.activations);
  assert.equal(restored.designUtc,result.chart.designUtc);
  assert.throws(()=>current.read(receipt,{...request,city:{...city,timezone:'Europe/London'}}),TypeError);
  const other=createCalculationReceipts({key:Buffer.alloc(32,8)});
  assert.throws(()=>other.read(receipt,request));
  assert.equal(current.issue({...request,mode:'transit_moment'},result),undefined);
  assert.equal(current.issue(request,{error:'busy',message:'busy'}),undefined);
  assert.throws(()=>createCalculationReceipts({key:Buffer.alloc(31)}),TypeError);
});
