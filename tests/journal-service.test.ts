import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fork,type ChildProcess} from 'node:child_process';
import {once} from 'node:events';
import {Worker} from 'node:worker_threads';
import {createJournalService,JOURNAL_EXTERNAL_RESERVED_BYTES} from '../server/journal-service.ts';
import {createJournalWriterClient} from '../server/journal/writer-client.ts';
import {createJournalRuntime} from '../server/journal/runtime.ts';
import {reportServiceFailure,serviceSocketPath} from '../server/journal/service-input.ts';
import {socketDirectory} from './helpers/socket-directory.ts';

test('external runtime writes through the sole owner and keeps only terminal mail locally',async t=>{
 const directory=await socketDirectory('forma-external-');
 const service=createJournalService({directory,environment:'stand'});
 const runtime=createJournalRuntime({directory,environment:'stand',writer:createJournalWriterClient({socketPath:serviceSocketPath(directory)})});
 t.after(async()=>{await runtime.close();await service.close();await fs.rm(directory,{recursive:true,force:true});});
 assert.equal(await service.ready,true);
 assert.equal(await runtime.report({event:'service_failed',component:'postfix',reason:'process'}),true);
 assert.equal((await runtime.usage()).journal.externalBytes,JOURNAL_EXTERNAL_RESERVED_BYTES);
 await runtime.close();
 assert.equal(await reportServiceFailure(serviceSocketPath(directory),{component:'postfix',reason:'cleanup'}),true);
 assert.equal((await service.usage()).ready,true,'closing the app leaves the sole writer alive');
 await service.close();
 const unavailable=createJournalRuntime({directory,environment:'stand',writer:createJournalWriterClient({socketPath:serviceSocketPath(directory)})});
 try {
  assert.equal(await unavailable.report({event:'service_failed',component:'postfix',reason:'process'}),false);
  const id='a'.repeat(32),fact={event:'mail_handed_off',eventId:'mail:'+id,occurredAt:Date.now(),
   codeId:id,contextId:id,recipient:'test@example.test',reason:'dsn:2.0.0'};
  assert.deepEqual(await unavailable.handoffMailReport(fact),{status:'buffered'});
  assert.equal(await unavailable.flushMail(),0);
 }finally{await unavailable.close();}
 const restarted=createJournalService({directory,environment:'stand'});
 const restored=createJournalRuntime({directory,environment:'stand',writer:createJournalWriterClient({socketPath:serviceSocketPath(directory)})});
 try{assert.equal(await restarted.ready,true);await restored.flushMail();}
 finally{await restored.close();await restarted.close();}
 const rows=(await Promise.all((await fs.readdir(path.join(directory,'archive'))).filter(n=>n.endsWith('.jsonl'))
  .map(n=>fs.readFile(path.join(directory,'archive',n),'utf8')))).join('').trim().split('\n').map(line=>JSON.parse(line));
 assert.equal(rows.length,3);assert.equal(rows.filter(row=>row.event==='mail_handed_off').length,1);
});

test('a real app SIGKILL leaves the independent writer alive; writer death has no embedded fallback',async t=>{
 const directory=await socketDirectory('forma-lifecycle-'),fixture=path.join(directory,'child.mjs');
 const serviceURL=new URL('../server/journal-service.ts',import.meta.url).href;
 const runtimeURL=new URL('../server/journal/runtime.ts',import.meta.url).href;
 const clientURL=new URL('../server/journal/writer-client.ts',import.meta.url).href;
 await fs.writeFile(fixture,`
 import {createJournalService} from ${JSON.stringify(serviceURL)};
 import {createJournalRuntime} from ${JSON.stringify(runtimeURL)};
 import {createJournalWriterClient} from ${JSON.stringify(clientURL)};
 const [role,directory,socketPath]=process.argv.slice(2);
 const owner=role==='writer'?createJournalService({directory,environment:'stand'}):
  createJournalRuntime({directory,environment:'stand',writer:createJournalWriterClient({socketPath})});
 process.on('message',async command=>{
  if(command==='report')process.send(await owner.report({event:'service_failed',component:'postfix',reason:'process'}));
  if(command==='close'){await owner.close();process.exit(0);}
 });
 process.send({ready:role==='writer'?await owner.ready:true,rss:process.memoryUsage().rss});
 `);
 const children:ChildProcess[]=[];
 t.after(async()=>{for(const child of children)if(child.exitCode===null && child.signalCode===null){const done=once(child,'exit');child.kill('SIGKILL');await done;}await fs.rm(directory,{recursive:true,force:true});});
 const start=async(role:string)=>{
  const child=fork(fixture,[role,directory,serviceSocketPath(directory)],{stdio:['ignore','ignore','ignore','ipc']});children.push(child);
  const [message]=await once(child,'message',{signal:AbortSignal.timeout(5000)});assert.equal(message.ready,true);return child;
 };
 const writer=await start('writer'),app=await start('app');
 const first=once(app,'message',{signal:AbortSignal.timeout(5000)});app.send('report');assert.equal((await first)[0],true);
 const appExit=once(app,'exit');app.kill('SIGKILL');await appExit;
 assert.equal(writer.exitCode,null);assert.equal(writer.signalCode,null);
 assert.equal(await reportServiceFailure(serviceSocketPath(directory),{component:'postfix',reason:'cleanup'}),true);
 const second=await start('app'),writerExit=once(writer,'exit');writer.kill('SIGKILL');await writerExit;
 const after=once(second,'message',{signal:AbortSignal.timeout(5000)});second.send('report');assert.equal((await after)[0],false);
 const appStopped=once(second,'exit');second.send('close');await appStopped;
 const rows=(await Promise.all((await fs.readdir(path.join(directory,'archive'))).filter(n=>n.endsWith('.jsonl'))
  .map(n=>fs.readFile(path.join(directory,'archive',n),'utf8')))).join('').trim().split('\n');
 assert.equal(rows.length,2,'failed external delivery must never open a fallback archive');
});

test('journal service rejects a failed archive or an occupied socket without taking the existing owner down',async t=>{
 const directory=await socketDirectory('forma-owner-');t.after(()=>fs.rm(directory,{recursive:true,force:true}));
 await fs.writeFile(path.join(directory,'archive'),'blocked');
 const failed=createJournalService({directory,environment:'stand'});
 assert.equal(await failed.ready,false);await failed.close();
 await fs.unlink(path.join(directory,'archive'));
 const first=createJournalService({directory,environment:'stand'});assert.equal(await first.ready,true);
 const second=createJournalService({directory,environment:'stand'});
 try{assert.equal(await second.ready,false);await second.close();assert.equal(await reportServiceFailure(serviceSocketPath(directory),{component:'postfix',reason:'process'}),true);}
 finally{await first.close();}
});

test('a failed final writer closes the service with a restartable failure instead of remaining falsely ready',async t=>{
 const directory=await socketDirectory('forma-writer-failure-');
 const service=createJournalService({directory,environment:'stand'});
 t.after(async()=>{await service.close();await fs.rm(directory,{recursive:true,force:true});});
 assert.equal(await service.ready,true);
 const broken=t.mock.method(Worker.prototype,'postMessage',()=>{throw Error('writer unavailable');});
 try {
  assert.equal(await reportServiceFailure(serviceSocketPath(directory),{component:'postfix',reason:'process'}),false);
  assert.equal(await service.stopped,1);
 }finally{broken.mock.restore();}
 assert.equal(await fs.stat(serviceSocketPath(directory)).then(()=>true,()=>false),false);
});
