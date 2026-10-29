import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createAppBundle } from '../src/offline/app-bundle.ts';
import { appMetadataAttributes } from '../shared/app-metadata.ts';
import type { OfflineManifest } from '../shared/offline-contract.ts';

const origin='https://forma.test', hash=(s:string)=>createHash('sha256').update(s).digest('hex');
class MemoryCaches {
 stores=new Map<string,Map<string,Response>>();
 failPut=false;
 beforePut:(()=>Promise<void>)|undefined;
 async keys(){return [...this.stores.keys()];}
 async has(name:string){return this.stores.has(name);}
 async delete(name:string){return this.stores.delete(name);}
 async open(name:string){
  let store=this.stores.get(name); if(!store){store=new Map();this.stores.set(name,store);}
  const entries=store;
  return {
   match:async(input:RequestInfo|URL)=>entries.get(typeof input==='string'?input:input instanceof URL?input.href:input.url)?.clone(),
   put:async(input:RequestInfo|URL,response:Response)=>{
    await this.beforePut?.();
    if(this.failPut)throw new DOMException('Full','QuotaExceededError');
    entries.set(typeof input==='string'?input:input instanceof URL?input.href:input.url,response.clone());
   },
  };
 }
}
function fixture(label='first', caches=new MemoryCaches()){
 const shell='<html><body><main>'+label+'</main></body></html>';
 const js='globalThis.label='+JSON.stringify(label);
 const jsUrl='/assets/startup-'+hash(js).slice(0,16)+'.js';
 const bodies=new Map([['/index.html',shell],[jsUrl,js],['/love.html','<html><body>love</body></html>']]);
 const manifest:OfflineManifest={version:hash(label),files:[...bodies].map(([url,body])=>({url,sha256:hash(body),bytes:Buffer.byteLength(body)}))};
 const calls:string[]=[];
 let online=true, corrupt=false;
 const fetcher:typeof fetch=async(input,init)=>{
  assert.equal(init?.credentials,'omit');assert.equal(init?.redirect,'error');
  const url=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url);
  calls.push(url.pathname);
  if(!online)throw new TypeError('offline');
  const body=bodies.get(url.pathname);if(body===undefined)return new Response('missing',{status:404});
  return new Response(corrupt?body+'broken':body,{headers:{'Content-Type':url.pathname.endsWith('.html')?'text/html':'application/javascript'}});
 };
 const bundle=createAppBundle({manifest,origin,caches,fetch:fetcher});
 return {bundle,manifest,bodies,caches,calls,jsUrl,shell,fetcher,setOnline:(v:boolean)=>online=v,setCorrupt:(v:boolean)=>corrupt=v};
}
function navigate(path:string){const request=new Request(origin+path);Object.defineProperty(request,'mode',{value:'navigate'});return request;}

test('prepared public files survive worker restart, reload and new-tab navigation without a network',async()=>{
 const f=fixture();await f.bundle.install();f.setOnline(false);
 const restarted=createAppBundle({manifest:f.manifest,origin,caches:f.caches,fetch:f.fetcher});
 await restarted.activate();
 for(const route of ['/','/account','/library','/charts','/chart','/chart/'+'1'.repeat(39),'/?fps=1']){
  assert.equal(await (await restarted.match(navigate(route)))?.text(),f.shell);
 }
 assert.equal(await (await restarted.match(new Request(origin+f.jsUrl)))?.text(),f.bodies.get(f.jsUrl));
 assert.equal(await (await restarted.match(navigate('/love')))?.text(),f.bodies.get('/love.html'));
 assert.equal(f.calls.length,f.manifest.files.length,'reads never fill a runtime cache');
});
test('network, truncated content and quota failure never replace the old complete bundle',async()=>{
 const old=fixture();await old.bundle.install();const names=await old.caches.keys();
 for(const failure of ['network','corrupt','quota']){
  const next=fixture(failure,old.caches);
  if(failure==='network')next.setOnline(false);
  if(failure==='corrupt')next.setCorrupt(true);
  if(failure==='quota')old.caches.failPut=true;
  await assert.rejects(next.bundle.install());old.caches.failPut=false;
  assert.deepEqual(await old.caches.keys(),names);
  assert.equal(await (await old.bundle.match(navigate('/')))?.text(),old.shell);
 }
});
test('metadata added by the server survives caching but only known valid fields are excluded from digest',async()=>{
 const f=fixture();f.bodies.set('/index.html',f.shell.replace('<body>','<body'+appMetadataAttributes({environment:'production',appVersion:'v2'})+'>'));
 await f.bundle.install();
 assert.match(await (await f.bundle.match(navigate('/')))!.text(),/data-app-version="v2"/);
 const bad=fixture('bad',f.caches);bad.bodies.set('/index.html',bad.shell.replace('<body>','<body data-private="secret">'));
 await assert.rejects(bad.bundle.install());
});
test('API, personal URLs, external resources, queries and non-GET requests never enter interception',async()=>{
 const f=fixture();await f.bundle.install();
 for(const request of [navigate('/api/charts'),new Request(origin+'/api/account'),new Request('https://telegram.org/x.js'),
  new Request(origin+f.jsUrl+'?secret=x'),new Request(origin+f.jsUrl,{method:'POST'}),navigate('/unknown')]){
  assert.equal(f.bundle.handles(request),false);
  assert.equal(await f.bundle.match(request),undefined);
 }
 for(const url of ['/api/account','/chart/123','https://telegram.org/a.js','/assets/a-12345678.json','/index.html?secret=x','/assets/../index.html']){
  assert.throws(()=>createAppBundle({origin,caches:f.caches,fetch:f.fetcher,manifest:{...f.manifest,files:[...f.manifest.files,{url,sha256:hash('x'),bytes:1}]}}));
 }
});
test('candidate is invisible until all bytes are complete; repeated install shares one download',async()=>{
 const f=fixture();let release!:()=>void;const gate=new Promise<void>(r=>release=r);
 const delayed:typeof fetch=async(input,init)=>{await gate;return f.fetcher(input,init);};
 const candidate=createAppBundle({manifest:f.manifest,origin,caches:f.caches,fetch:delayed});
 const first=candidate.install(),second=candidate.install();
 assert.equal(first,second);
 assert.deepEqual(await candidate.status(),{version:f.manifest.version,ready:false});
 assert.equal(await candidate.match(navigate('/')),undefined);
 release();await first;
 assert.equal((await candidate.status()).ready,true);assert.equal(f.calls.length,f.manifest.files.length);
 await candidate.install();assert.equal(f.calls.length,f.manifest.files.length);
});
test('activation preserves previous files; only approved prior versions can be retired, never newer versions',async()=>{
 const first=fixture();await first.bundle.install();
 const second=fixture('second',first.caches);await second.bundle.install();await second.bundle.activate();
 assert.equal(await (await second.bundle.match(new Request(origin+first.jsUrl)))?.text(),first.bodies.get(first.jsUrl),'old tabs can finish loading their hashed files');
 assert.equal(await first.bundle.retireApprovedVersion(first.manifest.version,second.manifest.version),false,'stale worker cannot erase the newer bundle');
 assert.equal(await second.bundle.retireApprovedVersion('wrong',first.manifest.version),false);
 assert.equal(await second.bundle.retireApprovedVersion(second.manifest.version,second.manifest.version),false);
 await first.caches.open('someone-elses-cache');
 assert.equal(await second.bundle.retireApprovedVersion(second.manifest.version,first.manifest.version),true);
 assert.equal(await first.caches.has('someone-elses-cache'),true);
 assert.equal(await second.bundle.match(new Request(origin+first.jsUrl)),undefined);
 assert.equal(await (await second.bundle.match(navigate('/')))!.text(),second.shell);
});
test('an incomplete or missing stored bundle cannot activate',async()=>{
 const f=fixture();await assert.rejects(f.bundle.activate());
 await f.bundle.install();
 const store=[...f.caches.stores.values()][0];store.delete(origin+f.jsUrl);
 await assert.rejects(f.bundle.activate());
});

test('repeating an old retirement cannot delete a newly installed copy of the same version',async()=>{
 const first=fixture();await first.bundle.install();
 const second=fixture('second',first.caches);await second.bundle.install();
 assert.equal(await second.bundle.retireApprovedVersion(second.manifest.version,first.manifest.version),true);
 const restored=fixture('first',first.caches);await restored.bundle.install();await restored.bundle.activate();
 assert.equal(await second.bundle.retireApprovedVersion(second.manifest.version,first.manifest.version),false);
 assert.equal((await restored.bundle.status()).ready,true);
});

test('activation rejects a stored file that no longer matches the prepared bytes',async()=>{
 const f=fixture();await f.bundle.install();
 const store=[...f.caches.stores.values()][0];store.set(origin+'/index.html',new Response('BROKEN'));
 await assert.rejects(f.bundle.activate());
});

test('rollback gets a fresh installation even when the prior complete bytes were retained',async()=>{
 const first=fixture();await first.bundle.install();
 const second=fixture('second',first.caches);await second.bundle.install();
 const restored=fixture('first',first.caches);restored.setOnline(false);
 await restored.bundle.install();await restored.bundle.activate();
 assert.equal(restored.calls.length,0,'verified previous bytes can be reused without fetching');
 assert.equal(await second.bundle.retireApprovedVersion(second.manifest.version,first.manifest.version),true);
 assert.equal((await restored.bundle.status()).ready,true,'the fresh installation survives stale deletion');
});


test('a later install removes abandoned partial bundles but preserves completed and unrelated caches',async()=>{
 const old=fixture();await old.bundle.install();const completed=await old.caches.keys();
 const abandoned='forma:app:'+hash('abandoned')+':'+'1'.repeat(32);
 const incomplete=await old.caches.open(abandoned);await incomplete.put(origin+'/index.html',new Response('partial'));
 await old.caches.open('another-app-cache');
 const next=fixture('next',old.caches);await next.bundle.install();
 assert.equal(await old.caches.has(abandoned),false);
 assert.equal(await old.caches.has('another-app-cache'),true);
 assert.equal(await old.caches.has(completed[0]!),true);
 assert.equal(await (await old.bundle.match(navigate('/')))!.text(),old.shell);
 assert.equal((await next.bundle.status()).ready,true);
});

test('failed reinstallation keeps the previously selected complete bundle readable',async()=>{
 const old=fixture();await old.bundle.install();const names=await old.caches.keys();
 const replacement=createAppBundle({manifest:old.manifest,origin,caches:old.caches,fetch:old.fetcher});
 old.caches.failPut=true;await assert.rejects(replacement.install());old.caches.failPut=false;
 assert.deepEqual(await old.caches.keys(),names);
 assert.equal(await (await replacement.match(navigate('/')))?.text(),old.shell);
 assert.equal((await replacement.status()).ready,true);
 await replacement.install();assert.equal((await replacement.status()).ready,true);
});

test('reinstallation serves the previous complete files until the new completion marker commits',async()=>{
 const old=fixture();await old.bundle.install();
 const replacement=createAppBundle({manifest:old.manifest,origin,caches:old.caches,fetch:old.fetcher});
 let entered!:()=>void,release!:()=>void;const writing=new Promise<void>(resolve=>{entered=resolve;});
 const blocked=new Promise<void>(resolve=>{release=resolve;});
 old.caches.beforePut=async()=>{entered();await blocked;};
 const installation=replacement.install();await writing;
 try {assert.equal(await (await replacement.match(navigate('/')))?.text(),old.shell);}
 finally {release();await installation;old.caches.beforePut=undefined;}
 assert.equal((await replacement.status()).ready,true);
});


test('status lists only still-existing predecessor versions, including an older installation of the same content',async()=>{
 const first=fixture();await first.bundle.install();
 const second=fixture('second',first.caches);await second.bundle.install();
 assert.deepEqual((await second.bundle.status()).previousVersions,[first.manifest.version]);
 const rollback=fixture('first',first.caches);await rollback.bundle.install();
 assert.deepEqual(new Set((await rollback.bundle.status()).previousVersions),new Set([first.manifest.version,second.manifest.version]));
 assert.equal(await rollback.bundle.retireApprovedVersion(first.manifest.version,first.manifest.version),true);
 assert.equal((await rollback.bundle.status()).ready,true);
 assert.deepEqual((await rollback.bundle.status()).previousVersions,[second.manifest.version]);
 await rollback.bundle.retireApprovedVersion(first.manifest.version,second.manifest.version);
 assert.deepEqual((await rollback.bundle.status()).previousVersions??[],[]);
});
