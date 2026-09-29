import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { gunzipSync, brotliDecompressSync } from 'node:zlib';
import { buildWeb } from '../scripts/build-web.mjs';
import { LOVE_GATES, renderLoveDiagram } from '../src/stories/vessel-of-love.js';

const project = fileURLToPath(new URL('../', import.meta.url));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

async function fileDigests(root) {
  const entries = [];
  async function walk(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(filename);
      else entries.push([path.relative(root, filename), digest(await fs.readFile(filename))]);
    }
  }
  await walk(root);
  return entries.sort(([a], [b]) => a.localeCompare(b));
}

function moduleReferences(source) {
  return [
    ...source.matchAll(/\b(?:from|import)\s*["']([^"']+)["']/g),
    ...source.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g),
  ].map(match => match[1]);
}

function stylesheetReferences(source) {
  return [
    ...source.matchAll(/url\(\s*["']?([^\s"')]+)["']?\s*\)/g),
    ...source.matchAll(/@import\s*["']([^"']+)["']/g),
  ].map(match => match[1]);
}

test('real release build preserves sources and produces complete deterministic compressed browser entries', async t => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'forma-web-build-'));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, 'source');
  await fs.mkdir(root);
  // Use the real browser graph while isolating this test from concurrent work
  // and ensuring the build never edits or publishes the working project.
  for (const directory of ['src', 'shared', 'public']) {
    await fs.cp(path.join(project, directory), path.join(root, directory), { recursive: true });
  }
  await fs.copyFile(path.join(project, 'package.json'), path.join(root, 'package.json'));
  // An independent snapshot must provide both its chart and its loading art.
  const placeholder = path.join(root, 'src/scene/loading-placeholder.js');
  await fs.writeFile(placeholder, (await fs.readFile(placeholder, 'utf8')).replace('loading-centers', 'loading-centers-from-root'));
  const before = await fileDigests(root);
  const outdir = path.join(temporary, 'first'), repeat = path.join(temporary, 'repeat');
  const manifest = await buildWeb({ root, outdir });
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(outdir, 'manifest.json'), 'utf8')), manifest);
  assert.deepEqual(await fileDigests(root), before, 'building preserves every source, stylesheet, icon and source HTML byte');
  assert.deepEqual(manifest.love, manifest['love.html'], 'the friendly story route resolves to its real HTML');

  const contents = new Map();
  for (const [route, entry] of Object.entries(manifest)) {
    assert.ok(!path.isAbsolute(entry.file) && !entry.file.split(/[\\/]/).includes('..'), route);
    const bytes = await fs.readFile(path.join(outdir, entry.file));
    contents.set(entry.file, bytes.toString());
    assert.deepEqual(gunzipSync(await fs.readFile(path.join(outdir, entry.gzip))), bytes, `${route}: gzip bytes`);
    assert.deepEqual(brotliDecompressSync(await fs.readFile(path.join(outdir, entry.br))), bytes, `${route}: Brotli bytes`);
    assert.equal(entry.immutable, entry.file.startsWith('assets/'), `${route}: only versioned assets have immutable caching`);
  }

  assert.deepEqual([...contents.get('index.html').matchAll(/<title>([^<]+)<\/title>/g)].map(match => match[1]), ['Форма'], 'release title excludes the local version label');
  assert.match(contents.get('index.html'), /<svg id="chartLoadingArt"/, 'release contains the silhouette before JavaScript starts');
  assert.match(contents.get('index.html'), /class="loading-centers-from-root"/, 'loading art comes from the requested source root');
  assert.doesNotMatch(contents.get('index.html'), /<!-- chart-loading-placeholder -->/, 'the build resolves the loading illustration');

  const resolve = (reference, parent) => {
    const url = new URL(reference, `https://forma.test/${parent}`);
    assert.equal(url.origin, 'https://forma.test', `${parent} contains no external release dependency`);
    const filename = url.pathname.slice(1);
    assert.ok(manifest[filename], `${parent} → ${reference} must resolve through the public manifest`);
    assert.equal(manifest[filename].file, filename);
    return filename;
  };
  const entries = new Map(), reached = new Set();
  for (const page of ['index.html', 'love.html']) {
    const html = contents.get(page);
    assert.ok(html, `${page} exists`);
    assert.equal(manifest[page].immutable, false, 'entry HTML must pick up future asset versions');
    const scripts = [...html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"[^>]*>/g)].map(match => resolve(match[1], page));
    const links = [...html.matchAll(/<link\b[^>]*\bhref="([^"]+)"[^>]*>/g)].map(match => resolve(match[1], page));
    assert.equal(scripts.length, 1, `${page} has one executable browser entry`);
    assert.equal(links.filter(filename => filename.endsWith('.css')).length, 1, `${page} preserves its stylesheet`);
    assert.equal(links.filter(filename => filename.endsWith('.svg')).length, 1, `${page} preserves its icon`);
    entries.set(page, scripts[0]);
    const imported = new Set();
    function visitImports(filename) {
      for (const reference of moduleReferences(contents.get(filename))) {
        const dependency = resolve(reference, filename);
        if (imported.has(dependency)) continue;
        imported.add(dependency); visitImports(dependency);
      }
    }
    visitImports(scripts[0]);
    for (const filename of links.filter(filename => filename.endsWith('.js'))) {
      assert.ok(imported.has(filename), `${page} must not preload another page's UI`);
    }
    const queue = [...scripts, ...links];
    while (queue.length) {
      const filename = queue.pop();
      if (reached.has(filename)) continue;
      reached.add(filename);
      assert.match(filename, /^assets\/.+-[A-Za-z0-9]+\.(?:js|css|svg)$/, 'every fetched dependency is content-versioned');
      const source = contents.get(filename);
      assert.equal(typeof source, 'string', filename);
      const references = filename.endsWith('.js') ? moduleReferences(source)
        : filename.endsWith('.css') ? stylesheetReferences(source) : [];
      for (const reference of references) {
        if (reference.startsWith('data:') || reference.startsWith('#')) continue;
        queue.push(resolve(reference, filename));
      }
    }
  }
  for (const filename of contents.keys()) {
    if (filename.startsWith('assets/')) assert.ok(reached.has(filename), `${filename} is used by a release page`);
  }
  const iconFile = [...reached].find(filename => filename.endsWith('.svg'));
  assert.deepEqual(await fs.readFile(path.join(outdir, iconFile)), await fs.readFile(path.join(root, 'public/favicon.svg')));

  await buildWeb({ root, outdir: repeat });
  assert.deepEqual(await fileDigests(repeat), await fileDigests(outdir), 'a second build in another directory has identical names, imports, manifest and compressed bytes');
  assert.deepEqual(await fileDigests(root), before);

  // Execute an actual entry and its extracted shared module, rather than merely
  // checking that minified text parses or that a synthetic function survived.
  await fs.writeFile(path.join(outdir, 'package.json'), '{"type":"module"}\n');
  const story = await import(pathToFileURL(path.join(outdir, entries.get('love.html'))));
  assert.deepEqual(story.LOVE_GATES, LOVE_GATES);
  assert.equal(story.renderLoveDiagram(), renderLoveDiagram(), 'the compiled chart renderer retains exact SVG geometry, gate labels, paint and selections');
});
