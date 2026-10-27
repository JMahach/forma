
import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import type { IncomingMessage } from 'node:http';
import { createRequestHandler } from '../server/http/app.ts';
import { createCityCatalog } from '../server/services/cities.ts';
import { captureResponse } from './helpers/http-response.ts';
type Calculator = Parameters<typeof createRequestHandler>[0]['calculate'];
const versions={calculationVersion:'a'.repeat(64),cyclesVersion:'b'.repeat(64)};
function handler(available=true){
 return createRequestHandler({root:'/',cities:createCityCatalog([]),// This unused calculator preserves its deliberately minimal response.
  calculate:(async()=>({error:'unused'})) as unknown as Calculator,
  ...(available?{versions}:{}),publicFiles:async()=>{throw new Error('version request must not be served as HTML');}});
}
async function request(handle:ReturnType<typeof handler>,method='GET',origin?:string){
 const req=Object.assign(Readable.from([]),{url:'/api/versions',method,headers:{host:'forma.example.test',...(origin?{origin}:{})}}) as unknown as IncomingMessage;
 const res=captureResponse();await handle(req,res);return res;
}
test('the live server exposes both actual calculation revisions together without caching or user data',async()=>{
 const res=await request(handler());
 assert.equal(res.status,200);assert.deepEqual(JSON.parse(res.body),versions);
 assert.equal(res.headers['Cache-Control'],'no-store');
 const post=await request(handler(),'POST');assert.equal(post.status,405);assert.equal(post.headers.Allow,'GET');
 assert.equal((await request(handler(),'GET','https://foreign.example.test')).status,403);
});
test('an unconfigured server does not invent revisions or fall back to the app page',async()=>{
 const res=await request(handler(false));assert.equal(res.status,503);
 assert.deepEqual(JSON.parse(res.body),{error:'versions_unavailable'});
});
