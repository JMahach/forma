import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { validateOfflineManifest, type OfflineManifest } from '../shared/offline-contract.ts';

const worker=fileURLToPath(new URL('../src/offline/service-worker.ts',import.meta.url));
const hash=(bytes:Uint8Array|string)=>createHash('sha256').update(bytes).digest('hex');
/** The build's existing output map is the entire public allow-list.
 * The worker itself is delivered separately; it never recursively caches itself. */
export async function buildOfflineWorker(outputs:ReadonlyMap<string,Uint8Array>):Promise<{bytes:Uint8Array;html:Uint8Array;manifest:OfflineManifest}> {
 const compile=async(manifest?:OfflineManifest)=>{
  const result=await build({entryPoints:[worker],bundle:true,write:false,format:'iife',platform:'browser',
   target:['safari15','chrome100'],minify:true,legalComments:'none',logLevel:'silent',
   ...(manifest?{define:{__FORMA_OFFLINE_MANIFEST__:JSON.stringify(manifest)}}:{})});
  return result.outputFiles[0].contents;
 };
 const files=[...outputs].sort(([a],[b])=>a.localeCompare(b)).map(([url,bytes])=>({url:'/'+url,sha256:hash(bytes),bytes:bytes.byteLength}));
 // Worker fixes also identify a new version even when the page files did not change.
 const implementation=await compile();
 const version=hash(hash(implementation)+'\n'+JSON.stringify(files));
 // Derive the version before stamping it, then hash the actual stamped HTML.
 // This avoids a self-referential digest without excluding identity from integrity.
 const source=outputs.get('index.html');if(!source)throw new Error('Offline shell is missing');
 const original=new TextDecoder('utf-8',{fatal:true}).decode(source);
 if(!/<body\b/.test(original)||/<body\b[^>]*\bdata-offline-version\b/.test(original))throw new Error('Offline shell identity is already set or body is missing');
 const html=new TextEncoder().encode(original.replace(/<body\b/,`<body data-offline-version="${version}"`));
 const shell=files.find(file=>file.url==='/index.html')!;shell.sha256=hash(html);shell.bytes=html.byteLength;
 const manifest=validateOfflineManifest({version,files});
 return {bytes:await compile(manifest),html,manifest};
}
