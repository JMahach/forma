import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const html = await fs.readFile(path.join(root, 'public/index.html'), 'utf8');
const entry = [...html.matchAll(/<script\b[^>]*src="\/(src\/[^"]+)"[^>]*><\/script>/g)].at(-1)![1];
const source = await fs.readFile(path.join(root, entry), 'utf8');

function browser(withArt = false) {
  const nodes = new Map(), body = { append(node) { node.parentElement = this; } };
  const shell = { hidden: false, inert: true, dataset: { booting: 'true' }, setAttribute() {} };
  for (const id of ['chartLoadingMessage', 'chartLoadingStatus', 'chartLoadingRetry'] as const) {
    const listeners = new Map();
    nodes.set(id, { parentElement: shell, hidden: id === 'chartLoadingRetry', textContent: '',
      addEventListener(type, fn) { listeners.set(type, fn); }, click() { listeners.get('click')?.(); } });
  }
  if (withArt) {
    nodes.set('chartLoadingArt', {hidden:false});
    nodes.set('canvasWrap', {dataset:{chartState:'loading'}});
  }
  const document = { body, querySelector: selector => selector === '.app-shell' ? shell : null, getElementById: id => nodes.get(id) };
  let reloads = 0;
  return { document, shell, nodes, location: { reload() { reloads++; } }, get reloads() { return reloads; } };
}

async function runEntry(t: test.TestContext, startup: string|NodeJS.ArrayBufferView<ArrayBufferLike>|Iterable<string|NodeJS.ArrayBufferView<ArrayBufferLike>>|AsyncIterable<string|NodeJS.ArrayBufferView<ArrayBufferLike>>, withArt = false) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'forma-entry-'));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  await fs.writeFile(path.join(temporary, 'package.json'), '{"type":"module"}');
  await fs.writeFile(path.join(temporary, 'entry.ts'), source);
  await fs.writeFile(path.join(temporary, 'startup.ts'), startup);
  const h = browser(withArt);
  const previous = { document: globalThis.document, location: globalThis.location };
  globalThis.document = h.document; globalThis.location = h.location;
  try { await import(pathToFileURL(path.join(temporary, 'entry.ts')).href); }
  finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete globalThis[name]; else globalThis[name] = value;
    }
  }
  return h;
}

test('a missing static startup dependency exposes only recovery outside the unprepared shell', async t => {
  const h = await runEntry(t, "import './missing-dependency.js';\nthrow new Error('startup body must never run');");
  assert.equal(h.shell.hidden, true, 'provisional buttons and panel positions stay hidden');
  assert.equal(h.shell.inert, true);
  assert.equal(h.shell.dataset.shellReady, undefined, 'failure never claims prepared geometry');
  assert.equal(h.nodes.get('chartLoadingMessage').parentElement, h.document.body, 'recovery escapes the hidden ancestor');
  assert.equal(h.nodes.get('chartLoadingMessage').hidden, false);
  assert.equal(h.nodes.get('chartLoadingStatus').textContent, 'Не удалось загрузить приложение');
  assert.equal(h.nodes.get('chartLoadingRetry').hidden, false);
  assert.equal(h.reloads, 0, 'failure never creates an automatic reload loop');
  globalThis.location = h.location;
  try { h.nodes.get('chartLoadingRetry').click(); } finally { delete globalThis.location; }
  assert.equal(h.reloads, 1, 'the existing retry performs one user-requested reload');
});

test('successful startup keeps ownership of the prepared shell and existing loading block', async t => {
  const h = await runEntry(t, 'document.querySelector(".app-shell").dataset.shellReady = "true";');
  assert.equal(h.shell.dataset.shellReady, 'true');
  assert.equal(h.shell.hidden, false);
  assert.equal(h.nodes.get('chartLoadingMessage').parentElement, h.shell);
  assert.equal(h.nodes.get('chartLoadingRetry').hidden, true);
  assert.equal(h.reloads, 0);
});

test('the existing no-JavaScript message is outside the shell gate', () => {
  const noScript = html.indexOf('<noscript>');
  assert.ok(noScript >= 0);
  const prefix = html.slice(0, noScript);
  assert.equal([...prefix.matchAll(/<div\b/g)].length - [...prefix.matchAll(/<\/div>/g)].length, 0,
    'noscript must not inherit the hidden app-shell opacity');
  assert.match(html.slice(noScript), /^<noscript><div class="chart-loading-message"><p>Для показа карты включите JavaScript в браузере\.<\/p><\/div><\/noscript>/);
});

test('a missing startup module keeps server preview and explicit recovery without exposing unfinished controls', async t => {
  const h = await runEntry(t, "import './missing-dependency.js';", true);
  assert.equal(h.shell.hidden, false, 'the server-rendered picture stays on screen');
  assert.equal(h.shell.inert, false, 'the recovery button stays usable');
  assert.equal(h.shell.dataset.shellReady, undefined, 'unfinished controls remain behind the CSS gate');
  assert.equal(h.shell.dataset.pageState, 'error');
  assert.equal(h.nodes.get('canvasWrap').dataset.chartState, 'error');
  assert.equal(h.nodes.get('chartLoadingMessage').parentElement, h.shell, 'error stays with the picture');
  assert.equal(h.nodes.get('chartLoadingStatus').textContent, 'Не удалось загрузить приложение');
  assert.equal(h.nodes.get('chartLoadingRetry').hidden, false);
  assert.equal(h.reloads, 0);
});
