import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { configureTransportSimulation } from '../src/data/http-transport.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const html = await fs.readFile(path.join(root, 'public/index.html'), 'utf8');
const entry = [...html.matchAll(/<script\b[^>]*src="\/(src\/[^"]+)"[^>]*><\/script>/g)].at(-1)![1];
const source = await fs.readFile(path.join(root, entry), 'utf8');
const transportURL = new URL('../src/data/http-transport.ts', import.meta.url).href;
const connectionURL = new URL('../src/dev/stand-connection.ts', import.meta.url).href;

// Deliberately small DOM model; installed only at the dynamic-module boundary.
class EntryElement {
  hidden = false;
  inert = false;
  textContent = '';
  parentElement: EntryElement | null = null;
  dataset: Record<string, string | undefined> = {};
  private attributes = new Map<string, string>();
  private listeners = new Map<string, () => void>();
  append(node: EntryElement) { node.parentElement = this; }
  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
  getAttribute(name: string) { return this.attributes.get(name) ?? null; }
  addEventListener(type: string, listener: () => void) { this.listeners.set(type, listener); }
  click() { this.listeners.get('click')?.(); }
}
function browser(withArt = false, standSrc?: string) {
  const nodes = new Map<string, EntryElement>(), body = new EntryElement(), shell = new EntryElement();
  shell.inert = true; shell.dataset.booting = 'true';
  for (const id of ['chartLoadingMessage', 'chartLoadingStatus', 'chartLoadingRetry'] as const) {
    const node = new EntryElement(); node.parentElement = shell; node.hidden = id === 'chartLoadingRetry'; nodes.set(id, node);
  }
  if (withArt) {
    nodes.set('chartLoadingArt', new EntryElement());
    const canvas = new EntryElement(); canvas.dataset.chartState = 'loading'; nodes.set('canvasWrap', canvas);
  }
  const document = { body, querySelector: (selector: string) => selector === '.app-shell' ? shell
    : selector === 'script[data-development][src="/src/dev/control-colors.ts"]' && standSrc ? {src: standSrc} : null,
  getElementById: (id: string) => nodes.get(id) };
  let reloads = 0;
  return { document, shell, nodes, location: { reload() { reloads++; } }, get reloads() { return reloads; } };
}
function installGlobals(values: Record<string, unknown>) {
  const previous = Object.getOwnPropertyDescriptors(globalThis);
  for (const [name, value] of Object.entries(values)) {
    if (value === undefined) Reflect.deleteProperty(globalThis, name);
    else Object.defineProperty(globalThis, name, {configurable: true, writable: true, value});
  }
  return () => { for (const name of Object.keys(values)) {
    if (previous[name]) Object.defineProperty(globalThis, name, previous[name]);
    else Reflect.deleteProperty(globalThis, name);
  } };
}

async function runEntry(t: test.TestContext, startup: string, withArt = false,
  {stand = false, devSource = '', release, preloadStand = false, offlineSource,
    journalSource, serviceWorkers, transportSource = `export {configureTransportSimulation, fetchResource} from ${JSON.stringify(transportURL)};`}: {
      serviceWorkers?: Pick<ServiceWorkerContainer,'register'>; stand?: boolean; devSource?: string; release?: boolean; journalSource?: string; preloadStand?: boolean; transportSource?: string; offlineSource?: string;
    } = {}) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'forma-entry-'));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  await fs.writeFile(path.join(temporary, 'package.json'), '{"type":"module"}');
  await fs.writeFile(path.join(temporary, 'entry.ts'), source);
  await fs.writeFile(path.join(temporary, 'startup.ts'), startup);
  if(offlineSource!==undefined){
    await fs.mkdir(path.join(temporary,'offline'));
    await fs.writeFile(path.join(temporary,'offline/page-coordinator.ts'),offlineSource);
  }
  if(journalSource!==undefined)await fs.writeFile(path.join(temporary,'journal.ts'),journalSource);
  await fs.mkdir(path.join(temporary, 'dev'));
  await fs.mkdir(path.join(temporary, 'data'));
  await fs.writeFile(path.join(temporary, 'data/http-transport.ts'), transportSource);
  const standFile = path.join(temporary, 'dev/control-colors.ts');
  await fs.writeFile(standFile, devSource);
  const h = browser(withArt, stand ? pathToFileURL(standFile).href : undefined);
  if(journalSource!==undefined)h.document.body.dataset={appVersion:'0.2-test',appEnvironment:'stand'};
  if(offlineSource!==undefined)h.document.body.dataset.offlineVersion='a'.repeat(64);
  const restoreGlobals = installGlobals({ document: h.document, location: h.location,
    fetch: async () => new Response('ordinary'), window:new EventTarget(), navigator:{serviceWorker:serviceWorkers}, __FORMA_RELEASE__: release });
  configureTransportSimulation(null);
  try {
    const preloaded = preloadStand ? import(pathToFileURL(standFile).href) : null;
    await import(pathToFileURL(path.join(temporary, 'entry.ts')).href);
    await preloaded;
    if(journalSource!==undefined||offlineSource!==undefined){await new Promise(resolve=>setImmediate(resolve));await new Promise(resolve=>setImmediate(resolve));}
  }
  finally {
    configureTransportSimulation(null);
    restoreGlobals();
  }
  return h;
}

test('a missing static startup dependency exposes only recovery outside the unprepared shell', async t => {
  const h = await runEntry(t, "import './missing-dependency.js';\nthrow new Error('startup body must never run');");
  assert.equal(h.shell.hidden, true, 'provisional buttons and panel positions stay hidden');
  assert.equal(h.shell.inert, true);
  assert.equal(h.shell.dataset.shellReady, undefined, 'failure never claims prepared geometry');
  assert.equal(h.nodes.get('chartLoadingMessage')!.parentElement, h.document.body, 'recovery escapes the hidden ancestor');
  assert.equal(h.nodes.get('chartLoadingMessage')!.hidden, false);
  assert.equal(h.nodes.get('chartLoadingStatus')!.textContent, 'Не удалось загрузить приложение');
  assert.equal(h.nodes.get('chartLoadingRetry')!.hidden, false);
  assert.equal(h.reloads, 0, 'failure never creates an automatic reload loop');
  const restoreLocation = installGlobals({ location: h.location });
  try { h.nodes.get('chartLoadingRetry')!.click(); } finally { restoreLocation(); }
  assert.equal(h.reloads, 1, 'the existing retry performs one user-requested reload');
});

test('successful startup keeps ownership of the prepared shell and existing loading block', async t => {
  const h = await runEntry(t, 'document.querySelector(".app-shell").dataset.shellReady = "true";');
  assert.equal(h.shell.dataset.shellReady, 'true');
  assert.equal(h.shell.hidden, false);
  assert.equal(h.nodes.get('chartLoadingMessage')!.parentElement, h.shell);
  assert.equal(h.nodes.get('chartLoadingRetry')!.hidden, true);
  assert.equal(h.reloads, 0);
});

for (const [mode, expected] of [['online', 'stand'], ['offline', 'offline'], ['server', 'server_unavailable']]) {
  test(`source installs the ${mode} stand gate before the first startup request`, async t => {
    const h = await runEntry(t, `import {fetchResource} from './data/http-transport.ts';
      const shell = document.querySelector('.app-shell');
      try { shell.dataset.firstRequest = await (await fetchResource('/api/startup')).text(); }
      catch (error) { shell.dataset.firstRequest = error.code; }`, false, {
      stand: true, preloadStand: true,
      devSource: `import {createStandConnection} from ${JSON.stringify(connectionURL)};
        const shell = document.querySelector('.app-shell');
        shell.dataset.devLoads = String(Number(shell.dataset.devLoads || 0) + 1);
        await new Promise(resolve => setTimeout(resolve, 0));
        const connection = createStandConnection(); connection.set(${JSON.stringify(mode)});
        export const standTransport = {connection, fetch: async () => {
          shell.dataset.devRequests = String(Number(shell.dataset.devRequests || 0) + 1);
          return new Response('stand');
        }};`,
    });
    assert.equal(h.shell.dataset.firstRequest, expected);
    assert.equal(h.shell.dataset.devLoads, '1', 'HTML and entry share one ESM evaluation');
    assert.equal(h.shell.dataset.devRequests, mode === 'online' ? '1' : undefined);
    assert.equal(h.nodes.get('chartLoadingRetry')!.hidden, true);
  });
}

test('a stand marker outside a supported port leaves transport untouched', async t => {
  const h = await runEntry(t, 'document.querySelector(".app-shell").dataset.started = "true";', false, {
    stand: true, devSource: 'export const standTransport = null;',
    transportSource: 'throw new Error("a null stand transport must not load request wiring");',
  });
  assert.equal(h.shell.dataset.started, 'true');
  assert.equal(h.nodes.get('chartLoadingRetry')!.hidden, true);
});

test('source without a stand marker skips dev code even when the module exists', async t => {
  const h = await runEntry(t, 'document.querySelector(".app-shell").dataset.started = "true";', false, {
    devSource: 'throw new Error("a page without the stand marker must not load dev code");',
  });
  assert.equal(h.shell.dataset.started, 'true');
  assert.equal(h.nodes.get('chartLoadingRetry')!.hidden, true);
});

test('a release entry ignores a leftover stand marker and never loads its module', async t => {
  const h = await runEntry(t, 'document.querySelector(".app-shell").dataset.started = "true";', false, {
    stand: true, release: true, devSource: 'throw new Error("release must not evaluate dev code");',
  });
  assert.equal(h.shell.dataset.started, 'true');
  assert.equal(h.nodes.get('chartLoadingRetry')!.hidden, true);
});

test('a missing stand dependency reaches recovery before startup can run', async t => {
  const h = await runEntry(t, 'document.querySelector(".app-shell").dataset.started = "true";', false, {
    stand: true, devSource: 'import "./missing-stand-dependency.ts";',
  });
  assert.equal(h.shell.dataset.started, undefined);
  assert.equal(h.shell.hidden, true);
  assert.equal(h.nodes.get('chartLoadingRetry')!.hidden, false);
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

test('a missing startup module shows recovery on a plain background without exposing unfinished controls', async t => {
  const h = await runEntry(t, "import './missing-dependency.js';", true);
  assert.equal(h.shell.hidden, false, 'the recovery block stays on screen');
  assert.equal(h.nodes.get('chartLoadingArt')!.getAttribute('hidden'), '', 'fatal application failure never shows an unprepared drawing');
  assert.equal(h.shell.inert, false, 'the recovery button stays usable');
  assert.equal(h.shell.dataset.shellReady, undefined, 'unfinished controls remain behind the CSS gate');
  assert.equal(h.shell.dataset.pageState, 'error');
  assert.equal(h.nodes.get('canvasWrap')!.dataset.chartState, 'error');
  assert.equal(h.nodes.get('chartLoadingMessage')!.parentElement, h.shell, 'the existing recovery block keeps its position');
  assert.equal(h.nodes.get('chartLoadingStatus')!.textContent, 'Не удалось загрузить приложение');
  assert.equal(h.nodes.get('chartLoadingRetry')!.hidden, false);
  assert.equal(h.reloads, 0);
});


test('diagnostics receives only a controlled early failure without delaying recovery',async t=>{
 const h=await runEntry(t,'throw new Error("PRIVATE hidden data");',false,{journalSource:`
  export function createJournal(){return{attachBrowser(){},begin(action){return{async reportFailure(fact){
   document.querySelector('.app-shell').dataset.diagnostic=JSON.stringify({action,fact});
  }}}};}`});
 assert.equal(h.nodes.get('chartLoadingRetry')!.hidden,false);
 const event=JSON.parse(h.shell.dataset.diagnostic!);
 assert.equal(event.action.action,'startup');assert.equal(event.fact.reason,'unclassified_error');
 assert.equal(h.shell.dataset.diagnostic!.includes('PRIVATE'),false);
});
test('a journal module which cannot finish loading does not hold back the application',async t=>{
 const h=await runEntry(t,'document.querySelector(".app-shell").dataset.started="true";',false,
  {journalSource:'await new Promise(()=>{}); export function createJournal(){}'});
 assert.equal(h.shell.dataset.started,'true');assert.equal(h.nodes.get('chartLoadingRetry')!.hidden,true);
});
test('normal startup receives the same journal owner once after both modules are available',async t=>{
 const h=await runEntry(t,`document.querySelector('.app-shell').dataset.started='true';
 export function connectJournal(journal){document.querySelector('.app-shell').dataset.connected=String(journal.marker);}`,
 false,{journalSource:`export function createJournal(){return{marker:42,attachBrowser(target,hints){
   if(target!==window || hints!==navigator)throw new Error('Incorrect browser source');
   const shell=document.querySelector('.app-shell');shell.dataset.attached=String(Number(shell.dataset.attached??0)+1);
  }};}`});
 assert.equal(h.shell.dataset.started,'true');assert.equal(h.shell.dataset.connected,'42');assert.equal(h.shell.dataset.attached,'1');
});


test('release prepares the offline worker without waiting for installation or activating an update',async t=>{
  const calls:unknown[]=[];
  const serviceWorkers={register:((...args:unknown[])=>{calls.push(args);return new Promise(()=>{});}) as ServiceWorkerContainer['register']};
  const startup='document.querySelector(".app-shell").dataset.shellReady="true";';
  const h=await runEntry(t,startup,false,{release:true,serviceWorkers});
  assert.equal(h.shell.dataset.shellReady,'true');assert.equal(h.reloads,0);
  assert.deepEqual(calls,[['/service-worker.js',{scope:'/',updateViaCache:'none'}]]);
  await runEntry(t,startup,false,{release:false,serviceWorkers});assert.equal(calls.length,1,'Source stand never installs a release worker');
});

test('offline registration failure never replaces the working application with startup recovery',async t=>{
  const h=await runEntry(t,'document.querySelector(".app-shell").dataset.shellReady="true";',false,
    {release:true,serviceWorkers:{register:()=>Promise.reject(new Error('Browser denied offline storage'))}});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(h.shell.dataset.shellReady,'true');assert.equal(h.nodes.get('chartLoadingRetry')!.hidden,true);
});

test('release connects a queued calculation mismatch to the existing page refresh without reloading directly',async t=>{
 const h=await runEntry(t,`
  export function prepareOfflineUpdate(){return false;}
  export function offlineRestored(){return false;}
  export function subscribeOfflineReady(){return()=>{};}
  export function offlineReady(){return Promise.resolve();}
  export function connectOfflineUpdates(refresh){refresh();}
  document.querySelector('.app-shell').dataset.shellReady='true';`,false,{
  release:true,serviceWorkers:{register:async()=>({} as ServiceWorkerRegistration)},
  offlineSource:`
   export function holdOfflineInput(){throw new Error('Discovery must not hold input');}
   export function attachOfflinePage(options){
    const shell=document.querySelector('.app-shell');
    shell.dataset.prepared=String(options.owner.prepare());
    return {refresh(){shell.dataset.refreshes=String(Number(shell.dataset.refreshes??0)+1);return Promise.resolve();},
      check(){shell.dataset.checks=String(Number(shell.dataset.checks??0)+1);return Promise.resolve();}};
   }`,
 });
 assert.equal(h.shell.dataset.shellReady,'true');
 assert.equal(h.shell.dataset.prepared,'false');
 assert.equal(h.shell.dataset.refreshes,'2','startup discovery and the queued mismatch reach the same page owner');
 assert.equal(h.shell.dataset.checks,'1');assert.equal(h.reloads,0);
});
