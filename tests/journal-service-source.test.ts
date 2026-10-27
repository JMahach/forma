import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import fs from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {pythonExecutable} from '../server/runtime/python.ts';
import {createServiceInput,serviceSocketPath} from '../server/journal/service-input.ts';

const root=fileURLToPath(new URL('../',import.meta.url)),run=promisify(execFile);
test('real prepare launchers and Postfix adapter send only safe service facts',{
 skip:!existsSync(pythonExecutable(root))&&'Project Python environment is not installed',
},async t=>{
 const directory=await fs.mkdtemp('/private/tmp/forma-source-');t.after(()=>fs.rm(directory,{recursive:true,force:true}));
 const rows:Record<string,unknown>[]=[];
 const input=createServiceInput({directory,report:async value=>{rows.push(value as Record<string,unknown>);return true;}});
 try {
  assert.equal(await input.ready,true);
  for(const module of ['server.python.lifetime_file','server.python.return_index']) {
   await assert.rejects(run(process.execPath,['scripts/python.ts','-m',module,'--forma-invalid-argument','PRIVATE'],{
    cwd:root,env:{...process.env,FORMA_JOURNAL_DIR:directory,FORMA_STATE_DIR:path.join(directory,'accounts')},timeout:5000,
   }),(error:unknown)=>(error as {code?:number}).code===2);
  }
  await assert.rejects(run(process.execPath,['scripts/python.ts','-c','raise SystemExit(7)'],{
   cwd:root,env:{...process.env,FORMA_JOURNAL_DIR:directory,FORMA_STATE_DIR:path.join(directory,'accounts')},timeout:5000,
  }),(error:unknown)=>(error as {code?:number}).code===7);
  const script=`import importlib.util,sys
spec=importlib.util.spec_from_file_location('control','deploy/postfix/control.py')
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
assert module.report_service_failure({'journalSocketPath':sys.argv[1],'database':'PRIVATE','secret':'PRIVATE'},'cleanup')
`;
  await run(pythonExecutable(root),['-c',script,serviceSocketPath(directory)],{cwd:root,timeout:5000});
  assert.deepEqual(rows.map(row=>[row.event,row.component,row.reason]),[
   ['service_failed','lifetime_prepare','process'],['service_failed','return_index_prepare','process'],['service_failed','postfix','cleanup'],
  ]);
  assert.equal(JSON.stringify(rows).includes('PRIVATE'),false);
  assert.ok(rows.every(row=>typeof row.eventId==='string' && typeof row.occurredAt==='number'));
 } finally {await input.close();}
});
