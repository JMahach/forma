import type { IncomingMessage, IncomingHttpHeaders, OutgoingHttpHeaders, ServerResponse } from 'node:http';
interface AssetResponse {
  status: number; headers: OutgoingHttpHeaders & { ETag?: string }; headersSent: boolean; body: Buffer | undefined;
  writeHead(status: number, headers?: AssetResponse['headers']): void; end(body?: Buffer): void;
}
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { brotliCompressSync, brotliDecompressSync, constants, gzipSync, gunzipSync } from 'node:zlib';
import { createStaticAssets } from '../server/http/static-assets.ts';
import { createPublicFileHandler, readReleaseManifest } from '../server/http/public-files.ts';
import { createRequestHandler } from '../server/http/app.ts';
import type { BinaryLike } from 'crypto';

const digest = (bytes: BinaryLike|undefined) => `"${createHash('sha256').update(bytes!).digest('base64url')}"`;
const content = Buffer.from('/* Форма */\nbody { color: #252525; background: #fff; }\n'.repeat(30));
const brotli = (bytes: Buffer) => brotliCompressSync(bytes, { params: { [constants.BROTLI_PARAM_QUALITY]: 1 } });
async function directory(t: test.TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forma-static-tests-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}
async function write(root: string, filename: string, bytes: string|NodeJS.ArrayBufferView<ArrayBufferLike>|NonSharedBuffer|Iterable<string|NodeJS.ArrayBufferView<ArrayBufferLike>>|AsyncIterable<string|NodeJS.ArrayBufferView<ArrayBufferLike>>) {
  await fs.mkdir(path.dirname(path.join(root, filename!)), { recursive: true });
  await fs.writeFile(path.join(root, filename), bytes);
}
async function request(handler: ReturnType<typeof createRequestHandler>, url: string, { method = 'GET', headers = {}, remoteAddress }: { method?: string; headers?: IncomingHttpHeaders;remoteAddress?:string } = {}) {
  const res: AssetResponse = { status: 0, headers: {}, headersSent: false, body: undefined,
    writeHead(status: number, headers = {}) { this.status = status; this.headers = headers; this.headersSent = true; },
    end(body?: Buffer) { this.body = body; } };
  await handler({ method, url, headers: { host: 'localhost', ...headers },socket:{remoteAddress} } as IncomingMessage, res as unknown as ServerResponse);
  return res;
}
function handler(root: string, options: Omit<Parameters<typeof createPublicFileHandler>[0], 'root'> = {}) {
  return createRequestHandler({ root, publicFiles: createPublicFileHandler({ root, ...options }) } as Parameters<typeof createRequestHandler>[0]);
}

test('HTML supplies the current cycle calculation revision without another request and changes its ETag', async t => {
  const root = await directory(t); await write(root, 'public/index.html', '<html><body>Форма</body></html>');
  const first = await request(handler(root, { cyclesVersion: 'a'.repeat(64) }), '/');
  assert.match(first.body!.toString(), /<body[^>]* data-cycles-version="a{64}"[^>]*>/);
  const next = await request(handler(root, { cyclesVersion: 'b'.repeat(64) }), '/');
  assert.match(next.body!.toString(), /data-cycles-version="b{64}"/); assert.notEqual(next.headers.ETag, first.headers.ETag);
  assert.equal(first.headers['Cache-Control'], 'no-cache');
  const legacy = await request(handler(root), '/'); assert.doesNotMatch(legacy.body!.toString(), /data-cycles-version/);
});
function releaseEntry(file: string, immutable = false) {
  return { file, br: `${file}.br`, gzip: `${file}.gz`, immutable };
}
function manifest() {
  return { 'index.html': releaseEntry('index.html'), 'love.html': releaseEntry('love.html'), love: releaseEntry('love.html'),
    'assets/app-ABCDEFGH.js': releaseEntry('assets/app-ABCDEFGH.js', true) };
}
async function release(root: string, entries = manifest()) {
  for (const entry of new Map(Object.values(entries).map(entry => [entry.file, entry])).values()) {
    await write(root, entry.file, content);
    await write(root, entry.br, brotli(content));
    await write(root, entry.gzip, gzipSync(content, { level: 1 }));
  }
  await write(root, 'manifest.json', JSON.stringify(entries));
  return readReleaseManifest(root);
}

test('development static assets negotiate exact bytes, representation ETags, HEAD and conditional GET', async t => {
  const root = await directory(t);
  await write(root, 'public/styles.css', content);
  const serve = handler(root), representations = [];
  for (const [accepted, encoding, unpack] of [[undefined, undefined, (bytes: Buffer) => bytes], ['gzip', 'gzip', gunzipSync], ['gzip,br', 'br', brotliDecompressSync]] as const) {
    const headers = accepted ? { 'accept-encoding': accepted } : {};
    const get = await request(serve, '/styles.css', { headers });
    assert.equal(get.status, 200);
    assert.deepEqual(unpack(get.body!), content);
    assert.equal(get.headers['Content-Encoding'], encoding);
    assert.equal(get.headers['Content-Type'], 'text/css; charset=utf-8');
    assert.equal(get.headers['Content-Length'], get.body!.length);
    assert.equal(get.headers['Cache-Control'], 'no-cache');
    assert.equal(get.headers['X-Content-Type-Options'], 'nosniff');
    assert.equal(get.headers.Vary, 'Accept-Encoding');
    assert.equal(get.headers.ETag, digest(get.body));
    const head = await request(serve, '/styles.css', { method: 'HEAD', headers });
    assert.equal(head.status, 200); assert.equal(head.body, undefined);
    assert.deepEqual(head.headers, get.headers);
    for (const tag of [get.headers.ETag, `"other", W/${get.headers.ETag}`, '*'] as const) {
      const cached = await request(serve, '/styles.css', { headers: { ...headers, 'if-none-match': tag } });
      assert.equal(cached.status, 304); assert.equal(cached.body, undefined);
      assert.deepEqual(cached.headers, get.headers);
    }
    representations.push(get);
  }
  assert.equal(new Set(representations.map(result => result.headers.ETag)).size, 3);
  const different = await request(serve, '/styles.css', { headers: { 'accept-encoding': 'br', 'if-none-match': representations[0].headers.ETag } });
  assert.equal(different.status, 200, 'an identity validator must not validate Brotli bytes');
  const weighted = await request(serve, '/styles.css', { headers: { 'accept-encoding': 'identity;q=0,br;q=.2,gzip;q=.9' } });
  assert.equal(weighted.headers['Content-Encoding'], 'gzip');
  const refused = await request(serve, '/styles.css', { headers: { 'accept-encoding': '*;q=0' } });
  assert.equal(refused.status, 406); assert.equal(refused.headers.Vary, 'Accept-Encoding');
});

test('initial HTML includes the empty silhouette before JavaScript in every encoding', async t => {
  const root = await directory(t);
  const source = '<html><body><!-- chart-loading-placeholder --></body></html>';
  await write(root, 'public/index.html', source);
  const serve = handler(root);
  let rendered;
  for (const [encoding, unpack] of [['identity', (bytes: Buffer) => bytes], ['gzip', gunzipSync], ['br', brotliDecompressSync]] as const) {
    const response = await request(serve, '/', { headers: { 'accept-encoding': encoding } });
    const html = unpack(response.body!).toString();
    assert.equal(response.status, 200);
    assert.match(html, /<svg id="chartLoadingArt"/);
    assert.match(html, /class="loading-centers"/);
    assert.doesNotMatch(html, /chart-loading-placeholder|data-activation|data-type|<script/);
    assert.equal(response.headers.ETag, digest(response.body));
    if (rendered) assert.equal(html, rendered);
    rendered = html;
  }
  assert.equal(await fs.readFile(path.join(root, 'public/index.html'), 'utf8'), source);
});

test('development revalidates source files while sharing concurrent encoding work', async t => {
  const root = await directory(t);
  const content = Buffer.from('export const value = 1;\n');
  await write(root, 'src/app.ts', content);
  const assets = createStaticAssets(root), entry = { file: 'src/app.ts' };
  const first = await Promise.all([assets.get(entry), assets.get(entry), assets.get(entry)]);
  assert.ok(first.every(value => value === first[0]));
  const serve = handler(root), previous = await request(serve, '/src/app.ts');
  const changed = Buffer.concat([content, Buffer.from('\n// changed')]);
  await write(root, 'src/app.ts', changed);
  const next = await request(serve, '/src/app.ts', { headers: { 'if-none-match': previous.headers.ETag } });
  assert.equal(next.status, 200); assert.deepEqual(next.body, changed);
  assert.notEqual(next.headers.ETag, previous.headers.ETag);
});

test('development and release HTML keep the timeline entry visible in every encoding without changing build files', async t => {
  for (const precompressed of [false, true] as const) {
    const root = await directory(t);
    const source = '<html><body><button id="fitButton" hidden>Домой</button><button id="lifetimeToggle">Летопись</button><main id="lifetimeControls" hidden>Форма</main></body></html>';
    const file = precompressed ? 'index.html' : 'public/index.html';
    const files = precompressed ? await release(root) : undefined;
    await write(root, file, source);
    if (precompressed) {
      await write(root, `${file}.br`, brotli(Buffer.from(source)));
      await write(root, `${file}.gz`, gzipSync(source));
    }
    const cyclesVersion = 'a'.repeat(64);
    const serve = handler(root, { files, precompressed, cyclesVersion });
    const expected = source.replace('<body>', `<body data-app-name="Форма 1" data-cycles-version="${cyclesVersion}">`);
    for (const [encoding, unpack] of [['identity', (bytes: Buffer) => bytes], ['gzip', gunzipSync], ['br', brotliDecompressSync]] as const) {
      const headers = { 'accept-encoding': encoding };
      const get = await request(serve, '/', { headers });
      assert.equal(get.status, 200);
      const html = unpack(get.body!).toString();
      assert.equal(html, expected);
      assert.match(html, /<button id="lifetimeToggle">/);
      assert.match(html, /<button id="fitButton" hidden>/, 'Home still waits for actual camera movement');
      assert.match(html, /<main id="lifetimeControls" hidden>/, 'the panel starts closed');
      assert.equal(get.headers.ETag, digest(get.body));
      assert.equal(get.headers['Content-Length'], get.body!.length);
      const head = await request(serve, '/', { method: 'HEAD', headers });
      assert.deepEqual(head.headers, get.headers); assert.equal(head.body, undefined);
      assert.equal((await request(serve, '/', { headers: { ...headers, 'if-none-match': get.headers.ETag } })).status, 304);
    }
    assert.equal(await fs.readFile(path.join(root, file), 'utf8'), source);
    if (precompressed) {
      assert.equal(gunzipSync(await fs.readFile(path.join(root, `${file}.gz`))).toString(), source);
      assert.equal(brotliDecompressSync(await fs.readFile(path.join(root, `${file}.br`))).toString(), source);
    }
  }
});

test('unlisted source, private files and encoded traversal are never served', async t => {
  const root = await directory(t);
  for (const filename of ['private.txt', 'src/unlisted.js', '.git/config', 'server/private.mjs', 'data/cities.json'] as const) {
    await write(root, filename, 'secret test fixture');
  }
  const serve = handler(root);
  for (const url of ['/private.txt', '/src/unlisted.js', '/.git/config', '/server/private.mjs', '/data/cities.json',
    '/src/%2e%2e/server/private.mjs', '/src/..%2fserver/private.mjs', '/%2e%2e%2fprivate.txt', '/manifest.json'] as const) {
    assert.equal((await request(serve, url)).status, 404, url);
  }
  assert.equal((await request(serve, '/%ZZ')).status, 400);
  const post = await request(serve, '/styles.css', { method: 'POST' });
  assert.equal(post.status, 405); assert.equal(post.headers.Allow, 'GET, HEAD');
});

test('release pages revalidate, hashed assets are immutable and use exact prebuilt encodings', async t => {
  const root = await directory(t), files = await release(root);
  await write(root, 'src/app.ts', 'private source');
  const serve = handler(root, { files, precompressed: true });
  for (const url of ['/', '/love', '/love.html', '/assets/app-ABCDEFGH.js'] as const) {
    const entry = files.get(url === '/' ? 'index.html' : url.slice(1));
    for (const [encoding, filename] of [['identity', entry!.file], ['br', entry!.br], ['gzip', entry!.gzip]] as const) {
      const response = await request(serve, url, { headers: { 'accept-encoding': encoding } });
      assert.equal(response.status, 200);
      assert.deepEqual(response.body, await fs.readFile(path.join(root, filename!)));
      assert.equal(response.headers['Cache-Control'], entry!.immutable ? 'public, max-age=31536000, immutable' : 'no-cache');
      assert.equal(response.headers['Content-Type'], entry!.immutable ? 'text/javascript; charset=utf-8' : 'text/html; charset=utf-8');
    }
  }
  for (const url of ['/src/app.ts', '/manifest.json', '/assets/app-ABCDEFGH.js.br', '/assets/app-ABCDEFGH.js.gz', '/assets/not-listed-12345678.js'] as const) {
    assert.equal((await request(serve, url)).status, 404, url);
  }
  await write(root, 'assets/app-ABCDEFGH.js', 'changed behind immutable release');
  assert.deepEqual((await request(serve, '/assets/app-ABCDEFGH.js')).body, content, 'release bytes stay fixed within this process');
});

test('failed prebuilt asset reads do not poison the representation cache', async t => {
  const root = await directory(t), assets = createStaticAssets(root, { precompressed: true });
  const entry = releaseEntry('index.html');
  await write(root, entry.file, content);
  await assert.rejects(assets.get(entry), error => (error as NodeJS.ErrnoException).code === 'ENOENT');
  await write(root, entry.br, brotli(content)); await write(root, entry.gzip, gzipSync(content));
  const repaired = await assets.get(entry);
  assert.deepEqual(repaired.bytes.identity, content);
  assert.deepEqual(brotliDecompressSync(repaired.bytes.br), content);
  assert.deepEqual(gunzipSync(repaired.bytes.gzip), content);
});

test('release manifest allows only generated pages and hashed assets with matching sidecars', async t => {
  const root = await directory(t), original = manifest();
  await release(root, original);
  assert.deepEqual(await readReleaseManifest(root), new Map(Object.entries(original)));
  const invalid = [
    { ...original, 'src/app.ts': releaseEntry('src/app.ts', true) },
    { ...original, 'assets/app.js': releaseEntry('assets/app.js', true) },
    { ...original, 'assets/../../secret-12345678.js': releaseEntry('assets/../../secret-12345678.js', true) },
    { ...original, 'assets/app-ABCDEFGH.js': { ...original['assets/app-ABCDEFGH.js'], file: '../secret.js' } },
    { ...original, 'assets/app-ABCDEFGH.js': { ...original['assets/app-ABCDEFGH.js'], br: '../secret.br' } },
    { ...original, 'assets/app-ABCDEFGH.js': { ...original['assets/app-ABCDEFGH.js'], gzip: 'wrong.gz' } },
    { ...original, 'assets/app-ABCDEFGH.js': { ...original['assets/app-ABCDEFGH.js'], immutable: false } },
    { ...original, 'index.html': { ...original['index.html'], immutable: true } },
    { ...original, love: releaseEntry('index.html') },
    Object.fromEntries(Object.entries(original).filter(([key]) => key !== 'love')),
    null, [], 'invalid',
  ];
  for (const entries of invalid) {
    await write(root, 'manifest.json', JSON.stringify(entries));
    await assert.rejects(readReleaseManifest(root));
  }
});

test('startup rejects a release missing an identity, Brotli or gzip file, or naming a directory', async t => {
  const root = await directory(t), entries = manifest();
  await release(root, entries);
  for (const key of ['file', 'br', 'gzip'] as const) {
    const file = path.join(root, entries['assets/app-ABCDEFGH.js'][key]);
    const bytes = await fs.readFile(file);
    await fs.unlink(file);
    await assert.rejects(readReleaseManifest(root), error => (error as NodeJS.ErrnoException).code === 'ENOENT');
    await fs.writeFile(file, bytes);
  }
  const file = path.join(root, entries['index.html'].br);
  await fs.unlink(file); await fs.mkdir(file);
  await assert.rejects(readReleaseManifest(root));
});


test('the actual initial page exposes the timeline button without a file availability flag', async () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const page = await request(handler(root), '/');
  const tag = page.body!.toString().match(/<button\b[^>]*\bid="lifetimeToggle"[^>]*>/)?.[0];
  assert.ok(tag);
  assert.doesNotMatch(tag, /\s+hidden(?=\s|>)/);
});


test('release exposes only its explicit mutable offline worker and nonlocal source requests expose none', async t => {
  const root = await directory(t);
  const entries = {...manifest(), 'service-worker.js': releaseEntry('service-worker.js')};
  const files = await release(root, entries);
  const response = await request(handler(root, {files, precompressed: true}), '/service-worker.js',
    {remoteAddress:'127.0.0.1',headers:{host:'localhost:3636'}});
  assert.equal(response.status, 200);
  assert.equal(response.headers['Content-Type'], 'text/javascript; charset=utf-8');
  assert.equal(response.headers['Cache-Control'], 'no-cache');
  assert.deepEqual(response.body, content);
  assert.equal((await request(handler(root), '/service-worker.js')).status, 404);
  for (const entry of [releaseEntry('server/server.ts'), releaseEntry('service-worker.js', true)]) {
    await write(root, 'manifest.json', JSON.stringify({...entries, 'service-worker.js': entry}));
    await assert.rejects(readReleaseManifest(root), /Invalid public release entry/);
  }
});

test('a versioned release shell still receives runtime metadata for diagnostics and calculations',async t=>{
 const root=await directory(t),source='<html><body data-offline-version="'+'a'.repeat(64)+'">Форма</body></html>';
 await write(root,'index.html',source);
 const response=await request(handler(root,{files:new Map([['index.html','index.html']]),appVersion:'0.2-test',environment:'stand',standNumber:'4',calculationVersion:'b'.repeat(64)}),'/');
 const html=response.body!.toString();
 assert.match(html,/data-app-name="Форма 4"/);
 assert.match(html,/data-app-version="0.2-test"/);assert.match(html,/data-app-environment="stand"/);
 assert.match(html,/data-calculation-version="b{64}"/);
 const {normalizeAppMetadata}=await import('../shared/app-metadata.ts');assert.equal(normalizeAppMetadata(html),source);
});


test('source mode serves the shared storage-pressure and input-restoration dependencies',async()=>{
  const app=handler(fileURLToPath(new URL('../',import.meta.url)));
  for(const file of ['src/data/storage-pressure.ts','src/domain/input-draft.ts','src/views/input-selection.ts']){
    const result=await request(app,'/'+file);
    assert.equal(result.status,200,file);
    assert.match(String(result.headers['Content-Type']),/javascript/,file);
    assert.ok(result.body?.length,file);
  }
});


test('loopback source retires the previous release worker without touching storage or navigating tabs',async t=>{
  const root=await directory(t),serve=handler(root);
  const response=await request(serve,'/service-worker.js',{headers:{host:'localhost:3636'},remoteAddress:'127.0.0.1'});
  assert.equal(response.status,200);assert.equal(response.headers['Content-Type'],'text/javascript; charset=utf-8');
  assert.equal(response.headers['Cache-Control'],'no-store');assert.equal(response.headers['Clear-Site-Data'],undefined);
  assert.equal(response.headers['Content-Length'],response.body!.length);
  type Event={waitUntil(promise:Promise<unknown>):void;respondWith?(value:unknown):void};
  const listeners=new Map<string,(event:Event)=>void>();let registered=true,waiting=true,intercepted=false;
  const self={addEventListener(name:string,listener:(event:Event)=>void){listeners.set(name,listener);},
    async skipWaiting(){waiting=false;},registration:{async unregister(){registered=false;return true;}},
    get clients(){return assert.fail('retirement must not claim or navigate tabs');},
    get caches(){return assert.fail('retirement must not clear public files');},
    get indexedDB(){return assert.fail('retirement must not touch personal data');}};
  runInNewContext(response.body!.toString(),{self});
  for(const name of ['install','activate']){
    const work:Promise<unknown>[]=[];const listener=listeners.get(name);assert.ok(listener);
    listener({waitUntil(promise){work.push(promise);}});await Promise.all(work);
  }
  assert.equal(waiting,false);assert.equal(registered,false);
  listeners.get('fetch')?.({waitUntil(){},respondWith(){intercepted=true;}});assert.equal(intercepted,false);
  const head=await request(serve,'/service-worker.js',{method:'HEAD',headers:{host:'127.0.0.1:3636'},remoteAddress:'::ffff:127.0.0.1'});
  assert.equal(head.status,200);assert.equal(head.body,undefined);
  assert.equal(head.headers['Content-Length'],response.body!.length);
});

test('source retirement is limited to local stand requests and preserves encoding negotiation',async t=>{
  const root=await directory(t),serve=handler(root);
  for(const remoteAddress of ['192.168.1.8',undefined])assert.equal((await request(serve,'/service-worker.js',{
    remoteAddress,headers:{host:'localhost:3636','x-forwarded-for':'127.0.0.1'}})).status,404);
  for(const host of ['forma.juxtaposition.ru','192.168.1.10:3636','localhost.evil:3636','user@localhost:3636']){
    assert.equal((await request(serve,'/service-worker.js',{remoteAddress:'127.0.0.1',headers:{host}})).status,404);
  }
  assert.equal((await request(handler(root,{environment:'production'}),'/service-worker.js',{
    remoteAddress:'127.0.0.1',headers:{host:'localhost:3636'}})).status,404);
  const local={remoteAddress:'::1',headers:{host:'[::1]:3636'}};
  const plain=await request(serve,'/service-worker.js',local);assert.equal(plain.status,200);
  for(const encoding of ['br','gzip']){
    const result=await request(serve,'/service-worker.js',{...local,headers:{...local.headers,'accept-encoding':encoding}});
    assert.equal(result.status,200);assert.equal(result.headers['Content-Encoding'],encoding);
    assert.deepEqual(encoding==='br'?brotliDecompressSync(result.body!):gunzipSync(result.body!),plain.body);
  }
  assert.equal((await request(serve,'/service-worker.js',{...local,headers:{...local.headers,'accept-encoding':'*;q=0'}})).status,406);
  assert.equal((await request(serve,'/service-worker.js',{...local,method:'POST'})).status,405);
});
