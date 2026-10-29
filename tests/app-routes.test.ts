
import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import type { IncomingMessage,ServerResponse } from 'node:http';
import { fileURLToPath } from 'node:url';
import { readAppRoute,appRoutePath,type AppRoute } from '../shared/app-routes.ts';
import { createNavigation } from '../src/platform/browser/navigation.ts';
import { createPublicFileHandler } from '../server/http/public-files.ts';

const id='12345678-1234-1234-1234-123456789012';
const cases:[string,AppRoute][]=[
 ['/',{kind:'transit'}],['/chart',{kind:'temporary-chart'}],['/chart/'+id,{kind:'chart',id}],
 ['/account',{kind:'account'}],['/charts',{kind:'charts'}],['/library',{kind:'library'}],
];
test('one route contract round-trips only the agreed pages, without private data or API fallback',()=>{
 for(const [url,route] of cases){assert.deepEqual(readAppRoute(url),route);assert.equal(appRoutePath(route),url);}
 assert.deepEqual(readAppRoute('/chart/'+'a'.repeat(32)),{kind:'chart',id:'a'.repeat(32)});
 for(const path of ['/api/missing','/api/charts','/chart/not-an-id','/chart/'+id+'/note',
  '/account/1','/charts/1','/%61ccount','//account','/chart/%2f','/chart/'+id+'?note=secret',
  '/server/server.ts','/unknown',undefined])assert.equal(readAppRoute(path),null,String(path));
 assert.throws(()=>appRoutePath({kind:'chart',id:'../../account'}));
});
function browser(){
 const entries=['/'];let index=0;const events=new EventTarget();
 const location={get pathname(){return entries[index];}};
 const history={
  pushState(_state:unknown,_unused:string,url?:string|URL|null){entries.splice(index+1);entries.push(String(url));index++;},
  replaceState(_state:unknown,_unused:string,url?:string|URL|null){entries[index]=String(url);},
 };
 return {location,history,events,entries,
  back(){if(index>0){index--;events.dispatchEvent(new Event('popstate'));}},
  forward(){if(index+1<entries.length){index++;events.dispatchEvent(new Event('popstate'));}}};
}
test('confirmed save replaces the temporary address; Back/Forward use the same owner and invalidate stale work',()=>{
 const b=browser(),navigation=createNavigation(b),seen:(AppRoute|null)[]=[];
 navigation.subscribe(snapshot=>seen.push(snapshot.route));
 navigation.navigate({kind:'temporary-chart'});
 const pending=navigation.snapshot;
 navigation.navigate({kind:'chart',id},{replace:true});
 assert.deepEqual(b.entries,['/','/chart/'+id]);
 assert.equal(navigation.isCurrent(pending),false);
 b.back();assert.deepEqual(navigation.snapshot.route,{kind:'transit'});
 b.forward();assert.deepEqual(navigation.snapshot.route,{kind:'chart',id});
 const current=navigation.snapshot;
 assert.equal(navigation.navigate({kind:'chart',id}),false);
 assert.equal(navigation.isCurrent(current),true);
 assert.deepEqual(seen,[{kind:'temporary-chart'},{kind:'chart',id},{kind:'transit'},{kind:'chart',id}]);
 navigation.destroy();b.back();assert.equal(navigation.isCurrent(current),false);
 assert.equal(navigation.navigate({kind:'library'}),false);assert.equal(seen.length,4);
});
test('direct pages serve the same shell; unknown API/private paths never become HTML',async()=>{
 const root=fileURLToPath(new URL('../',import.meta.url)),serve=createPublicFileHandler({root});
 async function request(pathname:string,method='GET'){
  const req=Readable.from([]) as unknown as IncomingMessage;req.method=method;req.headers={};
  let status=0,body='',headers:Record<string,unknown>={};
  const res={writeHead(s:number,h:Record<string,unknown>={}){status=s;headers=h;},
   end(value?:unknown){body=value===undefined?'':String(value);}} as unknown as ServerResponse;
  await serve(req,res,pathname);return {status,body,headers};
 }
 const home=await request('/');
 for(const [url] of cases){
  const result=await request(url);assert.equal(result.status,200,url);assert.equal(result.body,home.body,url);
  assert.equal((await request(url,'HEAD')).body,'');assert.equal((await request(url,'POST')).status,405);
 }
 for(const url of ['/api/missing','/server/server.ts','/chart/nope','/chart/'+id+'/notes'])
  assert.equal((await request(url)).status,404,url);
});


import { viewForRoute } from '../src/state/view-session.ts';
test('the address selects the restored screen and chart without borrowing another chart camera or moment', () => {
 const saved = {version: 1 as const, selectedId: 'a'.repeat(32), workspace: 'account' as const,
   camera: {x: 2, y: 3, scale: 4}, lifetime: {opened:true,mode:'lifetime'}, returns:{eventId:'old'}, pendingChartWrites:[]};
 const next = viewForRoute({kind:'chart',id:'b'.repeat(32)},saved as never);
 assert.equal(next?.selectedId,'b'.repeat(32));assert.equal(next?.workspace,'chart');
 assert.equal(next?.camera,null);assert.equal(next?.lifetime,null);assert.equal(next?.returns,null);
 assert.equal(next?.pendingChartWrites,saved.pendingChartWrites);
 const same = viewForRoute({kind:'chart',id:saved.selectedId},saved as never);
 assert.equal(same?.camera,saved.camera);assert.equal(same?.lifetime,saved.lifetime);
 assert.equal(viewForRoute({kind:'transit'},saved as never)?.selectedId,'current-transit');
 assert.equal(viewForRoute({kind:'library'},saved as never)?.workspace,'library');
 assert.equal(viewForRoute({kind:'library'},saved as never)?.selectedId,saved.selectedId);
});


import { isChartIdentifier, isOperationIdentifier } from '../shared/chart-record-contract.ts';
test('short numeric addresses and former long links use the same canonical chart ID', () => {
 const numeric='123456789012345678901234567890123456789';
 for(const id of ['1234567890','12345678901','1234567890123456789']){assert.equal(isChartIdentifier(id),true);assert.deepEqual(readAppRoute(appRoutePath({kind:'chart',id})),{kind:'chart',id});}
 assert.equal(isChartIdentifier(numeric),true);
 assert.equal(appRoutePath({kind:'chart',id:numeric}),'/chart/'+numeric.slice(0,10));
 assert.deepEqual(readAppRoute('/chart/'+numeric.slice(0,10)),{kind:'chart',id:numeric.slice(0,10)});
 assert.equal(isChartIdentifier(Number(numeric)),false);
 assert.equal(isChartIdentifier('1e38'),false);
 assert.equal(isChartIdentifier('1'.repeat(40)),false);
 assert.equal(isOperationIdentifier(numeric),false);
 assert.equal(isOperationIdentifier('12345678-1234-1234-1234-123456789012'),true);
});
