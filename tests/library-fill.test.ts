import test from 'node:test';
import assert from 'node:assert/strict';
import {pruneFillBudgets,planLibraryFill,reserveFill,finishFill,fillPackageKey,type FillControl,type FillRequest} from '../src/domain/library-fill.ts';
import type {LibraryCatalogEntry} from '../shared/library-catalog-contract.ts';
import type {LibraryInventory} from '../src/domain/library-maintenance.ts';
const lease={accountId:'1',generation:'g'};
const entry=(id:string):LibraryCatalogEntry=>({id,revision:1,name:id,source:'calculated',birthDate:'2000-01-01',birthTime:'12:00',packages:{card:{kind:'card',sourceKey:JSON.stringify([id,1])},day:{ref:{kind:'day',sourceKey:'day-'+id},ready:true},majorReturns:{sourceKey:'return-'+id,readyFamilies:['north_node','saturn']}}});
const inventory=():LibraryInventory=>({lease,cards:[],packages:[],usage:[]});
const request=(overrides:Partial<FillRequest>={}):FillRequest=>({lease,owner:'a',token:'one',sessionId:'s',now:10000,occasion:10000,candidate:{key:'card-a',chartId:'1',revision:1,ref:{kind:'card',sourceKey:'a'}},...overrides});
const control=():FillControl=>({flight:null,budgets:{}});
test('fill orders every card before days and whole families, with actual opening as priority',()=>{
 const inv=inventory();inv.usage=[{id:'1',openedAt:300},{id:'2',openedAt:100}];
 const plan=planLibraryFill([entry('2'),entry('1')],inv);
 assert.deepEqual(plan.map(tier=>tier.kind),['card','day','major-returns']);
 assert.deepEqual(plan[0].candidates.map(row=>row.chartId),['1','2']);assert.deepEqual(plan[1].candidates.map(row=>row.chartId),['1','2']);
 assert.deepEqual(plan[2].candidates.map(row=>row.ref.kind==='major-returns'?row.ref.family:null),['north_node','saturn','north_node','saturn']);
});
test('ready inventory avoids downloads, shared sources deduplicate, intentional misses still block lower tiers',()=>{
 const inv=inventory(),one=entry('1'),two=entry('2');two.packages.day=one.packages.day;two.packages.majorReturns=one.packages.majorReturns;
 inv.cards=[{id:'1',revision:1},{id:'2',revision:1}];inv.usage=[{id:'2',openedAt:50}];
 let plan=planLibraryFill([one,two],inv);assert.equal(plan[0].missing,false);assert.equal(plan[1].candidates.length,1);assert.equal(plan[1].candidates[0].chartId,'2');
 inv.packages=[{id:fillPackageKey(one.packages.day!.ref),ref:one.packages.day!.ref,chartIds:['1','2'],evicted:true,present:false}];
 plan=planLibraryFill([one,two],inv);assert.equal(plan[1].missing,true);assert.equal(plan[1].candidates.length,0);
 inv.cards=[];inv.usage=[{id:'1',openedAt:1,evicted:true},{id:'2',openedAt:2,evicted:true}];plan=planLibraryFill([one,two],inv);assert.equal(plan[0].missing,true);assert.equal(plan[0].candidates.length,0);
});
test('fill rights and the three-attempt budget survive tab handoff and require pause plus a new occasion',()=>{
 const state=control(),r=request();let grant=reserveFill(state,r);assert.equal(grant.kind,'acquired');if(grant.kind!=='acquired')throw Error();
 assert.equal(reserveFill(state,request({owner:'b',token:'two'})).kind,'blocked');
 finishFill(state,grant.permit,{kind:'failed'},10000);
 assert.deepEqual(reserveFill(state,request({owner:'b',now:10001})),{kind:'wait',at:11000});
 grant=reserveFill(state,request({owner:'b',now:11000}));assert.equal(grant.kind,'acquired');if(grant.kind!=='acquired')throw Error();finishFill(state,grant.permit,{kind:'failed'},11000);
 grant=reserveFill(state,request({owner:'c',now:16000}));assert.equal(grant.kind,'acquired');if(grant.kind!=='acquired')throw Error();finishFill(state,grant.permit,{kind:'failed'},16000);
 assert.equal(reserveFill(state,request({now:100000})).kind,'blocked');assert.equal(reserveFill(state,request({now:75000,occasion:75000})).kind,'blocked');
 assert.equal(reserveFill(state,request({now:76000,occasion:76000})).kind,'acquired');
});
test('Retry-After, 401 and quota keep their own fences; stale completion cannot release a successor',()=>{
 const state=control(),first=reserveFill(state,request());if(first.kind!=='acquired')throw Error();finishFill(state,first.permit,{kind:'failed',retryAfterMs:90000},10000);
 assert.deepEqual(reserveFill(state,request({now:20000,occasion:20000})),{kind:'wait',at:100000});
 const next=reserveFill(state,request({now:100000,occasion:100000,token:'new'}));if(next.kind!=='acquired')throw Error();
 assert.equal(finishFill(state,first.permit,{kind:'success'},100001),false);
 finishFill(state,next.permit,{kind:'unauthorized'},100001);assert.equal(reserveFill(state,request({now:200000,occasion:200000})).kind,'blocked');
 const signed=reserveFill(state,request({sessionId:'new-session',now:200000,occasion:200000}));if(signed.kind!=='acquired')throw Error();finishFill(state,signed.permit,{kind:'quota'},200000);
 assert.equal(reserveFill(state,request({sessionId:'new-session',now:300000,occasion:300000})).kind,'blocked');
 assert.equal(reserveFill(state,request({sessionId:'new-session',now:300000,occasion:300000,spaceRelief:true})).kind,'acquired');
});
test('an expired in-flight attempt imposes a shared pause, and successful placement clears only its own budget',()=>{
 const state=control(),first=reserveFill(state,request());if(first.kind!=='acquired')throw Error();
 const expiry=first.permit.expiresAt;
 assert.equal(reserveFill(state,request({now:expiry,occasion:expiry})).kind,'blocked');
 const next=reserveFill(state,request({now:expiry+60000,occasion:expiry+60000,token:'two'}));if(next.kind!=='acquired')throw Error();
 assert.equal(finishFill(state,next.permit,{kind:'success'},expiry+60001),true);assert.deepEqual(state.budgets,{});assert.equal(state.flight,null);
});

test('obsolete sources lose only their retry metadata; a live source and current flight retain their budget',()=>{
 const state=control(),one=entry('1'),key=fillPackageKey(one.packages.card),budget={attempts:3,occasion:1,notBefore:60001};
 state.budgets[key]={...budget};state.budgets.old={...budget};pruneFillBudgets(state,[one]);assert.deepEqual(Object.keys(state.budgets),[key]);assert.deepEqual(state.budgets[key],budget);
});
test('three cancelled requests also retain a finite pause, and 401 cannot be bypassed by choosing another package',()=>{
 const state=control();let now=10000;
 for(let i=0;i<3;i++){
  const grant=reserveFill(state,request({now,occasion:now,token:String(i)}));if(grant.kind!=='acquired')throw Error();finishFill(state,grant.permit,{kind:'cancelled'},now);now+=i===0?1000:5000;
 }
 assert.equal(reserveFill(state,request({now,occasion:now})).kind,'blocked');
 const other=control(),grant=reserveFill(other,request());if(grant.kind!=='acquired')throw Error();finishFill(other,grant.permit,{kind:'unauthorized'},10001);
 assert.equal(reserveFill(other,request({candidate:{...request().candidate,key:'other'},now:500000,occasion:500000})).kind,'blocked');
});
test('a completed timeout enforces sixty seconds even on a new occasion; the quota occasion must be strictly newer',()=>{
 const state=control(),grant=reserveFill(state,request());if(grant.kind!=='acquired')throw Error();
 assert.equal(finishFill(state,grant.permit,{kind:'failed'},40000),true);
 assert.equal(reserveFill(state,request({now:99999,occasion:99999})).kind,'blocked');
 const next=reserveFill(state,request({now:100000,occasion:100000,token:'two'}));if(next.kind!=='acquired')throw Error();
 assert.equal(finishFill(state,next.permit,{kind:'quota'},100020),true);
 assert.equal(reserveFill(state,request({now:200000,occasion:100000,spaceRelief:true})).kind,'blocked');
 assert.equal(reserveFill(state,request({now:200000,occasion:100010,spaceRelief:true})).kind,'blocked','a delayed payload notice predating the actual quota cannot reopen fill');
 assert.equal(reserveFill(state,request({now:200000,occasion:200000,spaceRelief:true})).kind,'acquired');
 const auth=control(),authorized=reserveFill(auth,request());if(authorized.kind!=='acquired')throw Error();
 assert.equal(finishFill(auth,authorized.permit,{kind:'unauthorized'},10001),true);
});
