import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createMailBufferClient } from '../server/journal/mail-buffer-client.ts';
import { completeJournalEvent } from '../server/journal/events.ts';

const fact=completeJournalEvent({event:'mail_handed_off',occurredAt:1000000,
  eventId:'mail:'+ 'a'.repeat(32)+':handed_off',codeId:'a'.repeat(32),contextId:'b'.repeat(32),
  recipient:'person@example.test',reason:'dsn:2.0.0'},
{environment:'stand',occurredAt:1000000,eventId:'unused'})!;

test('worker owns the durable buffer, survives process death and fails queued requests safely on close or bad startup',async t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'forma-mail-worker-'));
  fs.chmodSync(directory,0o700);t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const filename=path.join(directory,'pending.sqlite');
  const script=`import {createMailBufferClient} from './server/journal/mail-buffer-client.ts';
    const client=createMailBufferClient({filename:process.argv[1],now:()=>1000000});
    const result=await client.stage(JSON.parse(process.argv[2]));
    if(result.status!=='buffered')process.exit(2);
    process.kill(process.pid,'SIGKILL');`;
  const child=spawnSync(process.execPath,['--input-type=module','-e',script,filename,JSON.stringify(fact)],
    {cwd:process.cwd(),encoding:'utf8',timeout:10000});
  assert.equal(child.signal,'SIGKILL',child.stderr);
  const client=createMailBufferClient({filename,now:()=>1000001});
  t.after(()=>client.close());
  assert.deepEqual(await client.batch(),[fact]);
  assert.equal((await client.usage())?.records,1);
  assert.equal((await client.stage(fact)).status,'buffered');
  assert.equal(await client.acknowledge(fact),true);
  assert.deepEqual(await client.batch(),[]);
  await client.maintain();await client.close();
  assert.equal((await client.stage(fact)).status,'retryable');
  assert.equal(await client.usage(),null);

  const closing=createMailBufferClient({filename:path.join(directory,'closing.sqlite'),now:()=>1000001});
  const pending=Array.from({length:40},()=>closing.stage(fact));
  const stopped=closing.close();assert.equal(closing.close(),stopped);await stopped;
  assert.ok((await Promise.all(pending)).every(result=>result.status==='retryable'));
  const missing=createMailBufferClient({filename:path.join(filename,'invalid.sqlite'),now:()=>1000001});
  assert.equal((await missing.stage(fact)).status,'retryable');
  assert.deepEqual(await missing.batch(),[]);assert.equal(await missing.acknowledge(fact),false);
  await missing.close();
});
