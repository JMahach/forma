import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { brotliCompressSync, brotliDecompressSync, constants, gzipSync, gunzipSync } from 'node:zlib';
import { createStaticAssets } from '../server/http/static-assets.mjs';
import { createPublicFileHandler, readReleaseManifest } from '../server/http/public-files.mjs';
import { createRequestHandler } from '../server/http/app.mjs';

const digest = bytes => `"${createHash('sha256').update(bytes).digest('base64url')}"`;
const content = Buffer.from('/* Форма */\nbody { color: #252525; background: #fff; }\n'.repeat(30));
const brotli = bytes => brotliCompressSync(bytes, { params: { [constants.BROTLI_PARAM_QUALITY]: 1 } });
async function directory(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forma-static-tests-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}
async function write(root, filename, bytes) {
  await fs.mkdir(path.dirname(path.join(root, filename)), { recursive: true });
  await fs.writeFile(path.join(root, filename), bytes);
}
async function request(handler, url, { method = 'GET', headers = {} } = {}) {
  const res = { status: 0, headers: {}, headersSent: false, body: undefined,
    writeHead(status, headers = {}) { this.status = status; this.headers = headers; this.headersSent = true; },
    end(body) { this.body = body; } };
  await handler({ method, url, headers: { host: 'localhost', ...headers } }, res);
  return res;
}
function handler(root, options) {
  return createRequestHandler({ root, publicFiles: createPublicFileHandler({ root, ...options }) });
}
function releaseEntry(file, immutable = false) {
  return { file, br: `${file}.br`, gzip: `${file}.gz`, immutable };
}
function manifest() {
  return { 'index.html': releaseEntry('index.html'), 'love.html': releaseEntry('love.html'), love: releaseEntry('love.html'),
    'assets/app-ABCDEFGH.js': releaseEntry('assets/app-ABCDEFGH.js', true) };
}
async function release(root, entries = manifest()) {
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
  for (const [accepted, encoding, unpack] of [[undefined, undefined, bytes => bytes], ['gzip', 'gzip', gunzipSync], ['gzip,br', 'br', brotliDecompressSync]]) {
    const headers = accepted ? { 'accept-encoding': accepted } : {};
    const get = await request(serve, '/styles.css', { headers });
    assert.equal(get.status, 200);
    assert.deepEqual(unpack(get.body), content);
    assert.equal(get.headers['Content-Encoding'], encoding);
    assert.equal(get.headers['Content-Type'], 'text/css; charset=utf-8');
    assert.equal(get.headers['Content-Length'], get.body.length);
    assert.equal(get.headers['Cache-Control'], 'no-cache');
    assert.equal(get.headers['X-Content-Type-Options'], 'nosniff');
    assert.equal(get.headers.Vary, 'Accept-Encoding');
    assert.equal(get.headers.ETag, digest(get.body));
    const head = await request(serve, '/styles.css', { method: 'HEAD', headers });
    assert.equal(head.status, 200); assert.equal(head.body, undefined);
    assert.deepEqual(head.headers, get.headers);
    for (const tag of [get.headers.ETag, `"other", W/${get.headers.ETag}`, '*']) {
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
  for (const [encoding, unpack] of [['identity', bytes => bytes], ['gzip', gunzipSync], ['br', brotliDecompressSync]]) {
    const response = await request(serve, '/', { headers: { 'accept-encoding': encoding } });
    const html = unpack(response.body).toString();
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
  await write(root, 'src/app.js', content);
  const assets = createStaticAssets(root), entry = { file: 'src/app.js' };
  const first = await Promise.all([assets.get(entry), assets.get(entry), assets.get(entry)]);
  assert.ok(first.every(value => value === first[0]));
  const serve = handler(root), previous = await request(serve, '/src/app.js');
  const changed = Buffer.concat([content, Buffer.from('\n// changed')]);
  await write(root, 'src/app.js', changed);
  const next = await request(serve, '/src/app.js', { headers: { 'if-none-match': previous.headers.ETag } });
  assert.equal(next.status, 200); assert.deepEqual(next.body, changed);
  assert.notEqual(next.headers.ETag, previous.headers.ETag);
});

test('archive availability exposes Years in the first development/release HTML in every encoding without changing build files', async t => {
  for (const precompressed of [false, true]) {
    const root = await directory(t);
    const source = '<html><body><button id="fitButton" hidden>Домой</button><button id="lifetimeToggle" hidden>Годы</button><main id="lifetimeControls" hidden>Форма</main></body></html>';
    const file = precompressed ? 'index.html' : 'public/index.html';
    const files = precompressed ? await release(root) : undefined;
    await write(root, file, source);
    if (precompressed) {
      await write(root, `${file}.br`, brotli(Buffer.from(source)));
      await write(root, `${file}.gz`, gzipSync(source));
    }
    const tags = new Map();
    for (const lifetimeEnabled of [false, true]) {
      const serve = handler(root, { files, precompressed, lifetimeEnabled });
      const expected = lifetimeEnabled ? source.replace('<body>', '<body data-lifetime-enabled="true">')
        .replace('id="lifetimeToggle" hidden', 'id="lifetimeToggle"') : source;
      for (const [encoding, unpack] of [['identity', bytes => bytes], ['gzip', gunzipSync], ['br', brotliDecompressSync]]) {
        const headers = { 'accept-encoding': encoding };
        const get = await request(serve, '/', { headers });
        assert.equal(get.status, 200);
        const html = unpack(get.body).toString();
        assert.equal(html, expected);
        const toggle = html.match(/<button\b[^>]*\bid="lifetimeToggle"[^>]*>/)?.[0];
        assert.ok(toggle);
        assert.equal(/\s+hidden(?=\s|>)/.test(toggle), !lifetimeEnabled, 'Years availability is resolved before JavaScript');
        assert.match(html, /<button id="fitButton" hidden>/, 'Home still waits for actual camera movement');
        assert.match(html, /<main id="lifetimeControls" hidden>/, 'the optional panel starts closed');
        assert.equal(get.headers.ETag, digest(get.body));
        assert.equal(get.headers['Content-Length'], get.body.length);
        const head = await request(serve, '/', { method: 'HEAD', headers });
        assert.deepEqual(head.headers, get.headers); assert.equal(head.body, undefined);
        const tag = get.headers.ETag;
        assert.equal((await request(serve, '/', { headers: { ...headers, 'if-none-match': tag } })).status, 304);
        if (lifetimeEnabled) {
          assert.notEqual(tag, tags.get(encoding));
          assert.equal((await request(serve, '/', { headers: { ...headers, 'if-none-match': tags.get(encoding) } })).status, 200);
        } else tags.set(encoding, tag);
      }
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
  for (const filename of ['private.txt', 'src/unlisted.js', '.git/config', 'server/private.mjs', 'data/cities.json']) {
    await write(root, filename, 'secret test fixture');
  }
  const serve = handler(root);
  for (const url of ['/private.txt', '/src/unlisted.js', '/.git/config', '/server/private.mjs', '/data/cities.json',
    '/src/%2e%2e/server/private.mjs', '/src/..%2fserver/private.mjs', '/%2e%2e%2fprivate.txt', '/manifest.json']) {
    assert.equal((await request(serve, url)).status, 404, url);
  }
  assert.equal((await request(serve, '/%ZZ')).status, 400);
  const post = await request(serve, '/styles.css', { method: 'POST' });
  assert.equal(post.status, 405); assert.equal(post.headers.Allow, 'GET, HEAD');
});

test('release pages revalidate, hashed assets are immutable and use exact prebuilt encodings', async t => {
  const root = await directory(t), files = await release(root);
  await write(root, 'src/app.js', 'private source');
  const serve = handler(root, { files, precompressed: true });
  for (const url of ['/', '/love', '/love.html', '/assets/app-ABCDEFGH.js']) {
    const entry = files.get(url === '/' ? 'index.html' : url.slice(1));
    for (const [encoding, filename] of [['identity', entry.file], ['br', entry.br], ['gzip', entry.gzip]]) {
      const response = await request(serve, url, { headers: { 'accept-encoding': encoding } });
      assert.equal(response.status, 200);
      assert.deepEqual(response.body, await fs.readFile(path.join(root, filename)));
      assert.equal(response.headers['Cache-Control'], entry.immutable ? 'public, max-age=31536000, immutable' : 'no-cache');
      assert.equal(response.headers['Content-Type'], entry.immutable ? 'text/javascript; charset=utf-8' : 'text/html; charset=utf-8');
    }
  }
  for (const url of ['/src/app.js', '/manifest.json', '/assets/app-ABCDEFGH.js.br', '/assets/app-ABCDEFGH.js.gz', '/assets/not-listed-12345678.js']) {
    assert.equal((await request(serve, url)).status, 404, url);
  }
  await write(root, 'assets/app-ABCDEFGH.js', 'changed behind immutable release');
  assert.deepEqual((await request(serve, '/assets/app-ABCDEFGH.js')).body, content, 'release bytes stay fixed within this process');
});

test('failed prebuilt asset reads do not poison the representation cache', async t => {
  const root = await directory(t), assets = createStaticAssets(root, { precompressed: true });
  const entry = releaseEntry('index.html');
  await write(root, entry.file, content);
  await assert.rejects(assets.get(entry), error => error.code === 'ENOENT');
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
    { ...original, 'src/app.js': releaseEntry('src/app.js', true) },
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
  for (const key of ['file', 'br', 'gzip']) {
    const file = path.join(root, entries['assets/app-ABCDEFGH.js'][key]);
    const bytes = await fs.readFile(file);
    await fs.unlink(file);
    await assert.rejects(readReleaseManifest(root), error => error.code === 'ENOENT');
    await fs.writeFile(file, bytes);
  }
  const file = path.join(root, entries['index.html'].br);
  await fs.unlink(file); await fs.mkdir(file);
  await assert.rejects(readReleaseManifest(root));
});
