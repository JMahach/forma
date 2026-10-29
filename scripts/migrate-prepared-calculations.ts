// Explicit deployment step. Never invoked by HTTP or ordinary preparation.
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {migratePreparedLifetimeFile} from '../server/services/lifetime-transition.ts';
import {pythonExecutable, pythonEnvironment} from '../server/runtime/python.ts';

const root=fileURLToPath(new URL('../',import.meta.url)),args=process.argv.slice(2);
const targets=new Map<string,string>();
for(let index=0;index<args.length;index+=2) {
  const kind=args[index],file=args[index+1];
  if(!['--lifetime','--returns'].includes(kind) || !file || targets.has(kind)
    || kind==='--lifetime' && !file.endsWith('.f64le'))throw new TypeError('Expected --lifetime /path/file.f64le and/or --returns /path/index.bin');
  targets.set(kind,path.resolve(file));
}
if(!targets.size)throw new TypeError('Specify prepared files explicitly; there is no default migration target');
for(const [kind,file] of targets) {
  if(kind==='--lifetime') {
    const migrated=await migratePreparedLifetimeFile({file,metadataFile:file.replace(/\.f64le$/,'.metadata.json')});
    console.log(JSON.stringify({file,migrated}));
  } else {
    const {stdout}=await promisify(execFile)(pythonExecutable(root),['-m','server.python.return_index','--file',file,'--migrate'],
      {cwd:root,env:pythonEnvironment(),maxBuffer:64*1024});
    process.stdout.write(stdout);
  }
}
