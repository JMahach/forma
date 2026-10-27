import test from 'node:test';
import assert from 'node:assert/strict';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { captureResponse } from './helpers/http-response.ts';
import { createLifetimeClient, createLifetimeExplorer } from './fixtures/lifetime.ts';
import { createLifetimeMoments, createRequestHandler } from './fixtures/lifetime-service.ts';
import { LIFETIME_PLANETS } from '../shared/lifetime-format.ts';

const engine='Swiss Ephemeris 2.10.03',start=Date.parse('2026-10-01T00:00:00Z');
const metadata={startUtc:'2026-10-01T00:00:00Z',endExclusiveUtc:'2026-10-04T00:00:00Z',stepSeconds:600,samples:432,planets:LIFETIME_PLANETS,engine};
const utc=(index:number)=>new Date(start+index*600000).toISOString().replace('.000Z','Z');
const point=(index:number)=>({index,utc:utc(index),longitudes:Array(11).fill(21),design:{utc:utc(index),
 designUtc:new Date(start+index*600000-88*86400000).toISOString(),longitudes:Array(11).fill(34),designArcResidualDegrees:1e-11}});
async function http(handler:ReturnType<typeof createRequestHandler>,url:string){
 const res=captureResponse();
 await handler({method:'GET',url,headers:{host:'localhost'}} as IncomingMessage,res as unknown as ServerResponse);
 return {status:res.status,value:res.body?JSON.parse(res.body):null};
}
function harness(){
 const calculations:unknown[]=[],reads:number[]=[],requests:string[]=[];
 const calculate=async(input:unknown)=>{calculations.push(input);throw new Error('Lifetime must not calculate');};
 const options={lifetimeFile:{metadata,cacheIdentity:'a'.repeat(64),async getPoint(index:number){reads.push(index);return point(index);}},
  calculationFingerprint:'b'.repeat(64)};
 const moments=createLifetimeMoments(options)!;
 const handler=createRequestHandler({root:'/unused',calculate,lifetime:{...moments,getMetadata:async()=>moments.metadata},
  publicFiles:async(_request,response)=>{response.writeHead(404);response.end();}});
 const client=createLifetimeClient({fetch:async(url,options)=>{
  if(options?.signal?.aborted)throw new DOMException('Aborted','AbortError');
  requests.push(String(url));const result=await http(handler,String(url));
  return {ok:result.status===200,json:async()=>result.value};
 }});
 return {moments,handler,client,calculations,reads,requests};
}
test('restoring a missing 12:31 minute uses the same prepared 12:30 grid fallback without Python',async t=>{
 const h=harness(),explorer=createLifetimeExplorer({client:h.client});t.after(()=>explorer.close());
 assert.equal(await explorer.restore({opened:true,mode:'lifetime',fromDate:'2026-10-01',toDate:'2026-10-03',requestedUtc:Date.parse('2026-10-02T12:31:00Z')}),true);
 assert.equal(explorer.current!.utc,'2026-10-02T12:30:00Z');
 assert.equal(explorer.state.requestedUtc,Date.parse('2026-10-02T12:30:00Z'));
 assert.equal(explorer.current!.activations!.personality.length,13);
 assert.equal(explorer.current!.planetFilter!.designActivations.length,13);
 assert.deepEqual(h.calculations,[]);assert.deepEqual(h.reads,[219]);
 assert.ok(h.requests.every(url=>!url.includes('/moment?')));
});
test('the removed arbitrary-UTC endpoint never dispatches a calculation',async()=>{
 const h=harness();
 assert.equal((await http(h.handler,'/api/lifetime/moment?utc=2026-10-02T12%3A31%3A00Z')).status,404);
 assert.deepEqual(h.calculations,[]);assert.deepEqual(h.reads,[]);
 assert.equal('getUtcMoment' in h.moments,false);
});
test('independent HTTP visits read prepared numbers again with unchanged version and no calculation',async()=>{
 const h=harness();const meta=(await http(h.handler,'/api/lifetime/meta')).value;
 const url='/api/lifetime?index=219&v='+meta.cacheVersion;
 const first=await http(h.handler,url),second=await http(h.handler,url);
 assert.equal(first.status,200);assert.deepEqual(first.value,point(219));assert.deepEqual(second.value,first.value);
 assert.deepEqual(h.reads,[219,219]);assert.deepEqual(h.calculations,[]);
});
