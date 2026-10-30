import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createJournalService} from '../server/journal-service.ts';
import {createSystemSource} from '../server/journal/system-source.ts';
import {serviceSocketPath} from '../server/journal/service-input.ts';
import {pythonExecutable} from '../server/runtime/python.ts';
import {socketDirectory} from './helpers/socket-directory.ts';

const root=fileURLToPath(new URL('../',import.meta.url)),python=pythonExecutable(root),execute=promisify(execFile);
const script=path.join(root,'server/python/system_journal.py');
async function records(directory:string) {
 return (await Promise.all((await fs.readdir(path.join(directory,'archive'))).filter(n=>n.endsWith('.jsonl'))
  .map(n=>fs.readFile(path.join(directory,'archive',n),'utf8')))).join('').trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));
}
test('the child adapter sends sanitized nginx and system stop facts to the one durable archive',async t=>{
 const directory=await socketDirectory('forma-sources-'),socketPath=path.join(directory,'proxy','nginx.sock');
 const service=createJournalService({directory,environment:'stand',source:{python,script,socketPath}});
 t.after(async()=>{await service.close();await fs.rm(directory,{recursive:true,force:true});});
 assert.equal(await service.ready,true);assert.equal((await fs.stat(socketPath)).mode&0o777,0o620);
 await execute(python,['-c',"import socket,sys; s=socket.socket(socket.AF_UNIX,socket.SOCK_DGRAM); [s.sendto(v.encode(),sys.argv[1]) for v in sys.argv[2:]]; s.close()",socketPath,
  '<187>Oct 30 12:00:00 forma_proxy: 502 PRIVATE', '<187>Oct 30 12:00:00 forma_proxy: 502']);
 const deadline=Date.now()+2000;
 while(!(await records(directory)).length && Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,10));
 assert.equal((await records(directory)).length,1);
 await execute(python,[script,'stop','--component','application_service','--writer',serviceSocketPath(directory)],
  {env:{...process.env,SERVICE_RESULT:'oom-kill',EXIT_CODE:'killed',EXIT_STATUS:'KILL',MESSAGE:'PRIVATE'}});
 await execute(python,[script,'stop','--component','application_service','--writer',serviceSocketPath(directory)],
  {env:{...process.env,SERVICE_RESULT:'success'}});
 const rows=await records(directory);
 assert.deepEqual(rows.map(row=>[row.component,row.reason]),[['nginx_proxy','bad_gateway'],['application_service','oom']]);
 assert.equal(JSON.stringify(rows).includes('PRIVATE'),false);
 await service.close();assert.equal(await fs.stat(socketPath).then(()=>true,()=>false),false);
});

test('adapter startup failure or later death stops the journal service instead of creating a separate restart loop',async t=>{
 const directory=await socketDirectory('forma-source-dies-'),socketPath=path.join(directory,'proxy','nginx.sock');
 t.after(()=>fs.rm(directory,{recursive:true,force:true}));
 const missing=createJournalService({directory,environment:'stand',source:{python,script:path.join(directory,'missing.py'),socketPath}});
 t.after(()=>missing.close());
 assert.equal(await missing.ready,false);assert.equal(await missing.stopped,1);await missing.close();
 const crashing=path.join(directory,'crashing.py');
 await fs.writeFile(crashing,"import time\nprint('READY',flush=True)\ntime.sleep(.1)\nraise SystemExit(7)\n");
 const dies=createJournalService({directory,environment:'stand',source:{python,script:crashing,socketPath}});
 try {assert.equal(await dies.ready,true);assert.equal(await dies.stopped,1);}
 finally{await dies.close();}
 assert.equal(await fs.stat(serviceSocketPath(directory)).then(()=>true,()=>false),false);
});

test('source readiness accepts fragmented confirmation and rejects invalid or unbounded child output',async t=>{
 const directory=await socketDirectory('forma-source-ready-');
 t.after(()=>fs.rm(directory,{recursive:true,force:true}));
 for(const [chunks,expected] of [[['REA','DY\n'],true],[['WRONG\n'],false],[['READY\nEXTRA'],false]] as const) {
  const source=path.join(directory,'source.py');
  await fs.writeFile(source,`import sys,time\nfor text in ${JSON.stringify(chunks)}:\n sys.stdout.write(text);sys.stdout.flush();time.sleep(.03)\ntime.sleep(30)\n`);
  const adapter=createSystemSource({python,script:source,socketPath:path.join(directory,'unused'),writerPath:path.join(directory,'unused-writer')});
  try {assert.equal(await adapter.ready,expected);if(!expected)await adapter.stopped;}
  finally {await adapter.close();}
 }
});
