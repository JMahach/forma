import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import type { IncomingMessage } from 'node:http';
import { IDBFactory } from 'fake-indexeddb';
import { createJournal } from '../src/journal.ts';
import { createDiagnosticClient } from '../src/data/diagnostic-client.ts';
import { createDiagnosticQueue } from '../src/data/diagnostic-queue.ts';
import { createDiagnosticHandler, DIAGNOSTIC_HTTP_RESERVED_BYTES } from '../server/http/diagnostics.ts';
import { createJournalRuntime } from '../server/journal/runtime.ts';
import { captureResponse } from './helpers/http-response.ts';
import type { ClientReport } from '../shared/client-report-contract.ts';

async function until(check:()=>boolean|Promise<boolean>){
 for(let i=0;i<300;i++){if(await check())return;await new Promise(resolve=>setTimeout(resolve,5));}
 assert.fail('Journal source path did not settle');
}
function records(directory:string):Array<ClientReport & {receivedAt:number;deliveryIp:string}> {
 const archive=path.join(directory,'archive');if(!fs.existsSync(archive))return [];
 return fs.readdirSync(archive).filter(file=>file.endsWith('.jsonl')).flatMap(file=>fs.readFileSync(path.join(archive,file),'utf8')
  .trim().split('\n').filter(Boolean).map(line=>JSON.parse(line)));
}
test('runtime failure survives offline reload and a lost HTTP ACK without duplicating the durable JSONL event',async t=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'forma-journal-source-path-')),indexedDB=new IDBFactory();
 let time=1_000_000,online=false,lost=true,deliveryIp='192.0.2.10',requests=0;
 const runtime=createJournalRuntime({directory,environment:'stand',now:()=>time,clientReservedBytes:DIAGNOSTIC_HTTP_RESERVED_BYTES});
 let journal:ReturnType<typeof createJournal>|undefined;
 t.after(async()=>{await journal?.close();await runtime.close();fs.rmSync(directory,{recursive:true,force:true});});
 const http=createDiagnosticHandler({origins:['https://forma.example.test'],accounts:{diagnosticOwner:()=>null},
  write:({deliveryIp,...report})=>runtime.receiveClient(report,deliveryIp)});
 const fetch:typeof globalThis.fetch=async(url,options)=>{
  assert.equal(url,'/api/diagnostics');assert.equal(options?.method,'POST');requests++;
  const headers=Object.fromEntries(new Headers(options?.headers));
  const request=Object.assign(Readable.from([options!.body as string]),{url:'/api/diagnostics',method:'POST',
   headers:{...headers,host:'forma.example.test',origin:'https://forma.example.test'},socket:{remoteAddress:deliveryIp}}) as unknown as IncomingMessage;
  const response=captureResponse();await http(request,response);
  if(lost){lost=false;throw new TypeError('lost response after durable acceptance');}
  return new Response(response.body,{status:response.status,headers:{'Content-Type':'application/json'}});
 };
 const options={indexedDB,appVersion:'test-1',environment:'stand' as const,now:()=>time,
  connection:()=>online?'online' as const:'offline' as const,send:createDiagnosticClient({fetch})};
 journal=createJournal(options);journal.attachBrowser(new EventTarget(),{userAgent:'unknown'});
 const target=new EventTarget();journal.attachBrowser(target,{userAgent:'Mozilla/5.0 (X11; Linux x86_64) Firefox/131.0'});
 const event=new Event('error');Object.defineProperty(event,'error',{value:Object.assign(new Error('private text'),{code:'invalid_response'})});
 target.dispatchEvent(event);
 const inspect=createDiagnosticQueue({indexedDB,now:()=>time});t.after(()=>inspect.close());
 await until(async()=>{const state=await inspect.state();return state.status==='ready' && state.count===1;});
 assert.equal(requests,0);await journal.close();
 online=true;time+=100;
 journal=createJournal(options);await journal.wake();
 await until(()=>records(directory).length===1);
 const original=records(directory)[0]!;
 assert.equal(original.action,'runtime');assert.deepEqual(original.browser,{name:'firefox',version:'131.0'});
 assert.equal(original.deliveryIp,'192.0.2.10');assert.equal(original.occurredAt,1_000_000);assert.equal(original.receivedAt,1_000_100);
 assert.doesNotMatch(JSON.stringify(original),/private text|Mozilla/);
 const waiting=await inspect.state();assert.equal(waiting.status,'ready');assert.equal(waiting.count,1);
 await journal.close();
 time+=2_000;deliveryIp='2001:db8::10';journal=createJournal(options);await journal.wake();
 await until(async()=>{const state=await inspect.state();return state.status==='ready' && state.count===0;});
 assert.equal(requests,2);assert.deepEqual(records(directory),[original]);
 await journal.wake();assert.equal(requests,2,'an empty queue does not poll');
});
