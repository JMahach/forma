import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Run the entry module with its browser ports, leaving its actual initialization
// order intact while replacing the network-loaded application.
const source = readFileSync(new URL('../src/startup.js', import.meta.url), 'utf8')
  .replace(/^import .*;\n/gm, '').replace("import('./app.js')", 'loadApp()');
const run = new (Object.getPrototypeOf(async function () {}).constructor)(
  'document', 'ResizeObserver', 'createTransitDayClient', 'createStudioLayout', 'createToast', 'createViewStore', 'loadApp', 'location', source);

test('startup reads the tab once and prefetches only a day that owns the saved view', async () => {
  for (const [savedView, needsDay] of [
    [null, true],
    [{ selectedId: 'current-transit', transit: { live: false } }, true],
    [{ selectedId: 'current-transit', lifetime: { opened: true, mode: 'lifetime' } }, false],
    [{ selectedId: 'personal' }, false],
    [{ selectedId: 'personal', lifetime: { opened: true, mode: 'lifetime', personalPreview: true, personalLive: false } }, false],
    [{ selectedId: 'personal', lifetime: { opened: true, mode: 'lifetime', personalLive: true } }, true],
    [{ selectedId: 'personal', lifetime: { opened: true, mode: 'lifetime', personalLive: true }, returns: { eventId: 'exact' } }, false],
  ]) {
    let reads = 0, creates = 0, options, received;
    const toast = () => {}, layout = {}, client = {};
    const viewStore = { read() { reads++; return savedView; } };
    const document = { hidden: false, getElementById: () => ({}) };
    await run(document, class { observe() {} disconnect() {} }, value => { options = value; return client; }, () => layout,
      () => toast, () => { creates++; return viewStore; }, async () => ({ startApp(value) { received = value; } }));
    assert.equal(Boolean(options.initialDate), needsDay, JSON.stringify(savedView));
    assert.equal(creates, 1); assert.equal(reads, 1);
    assert.deepEqual(received, { dayClient: client, layout, toast, viewStore, savedView });
  }
});

for (const failure of ['import', 'initialization']) {
  test(`${failure} failure replaces endless loading with an explicit reload action`, async () => {
    const attributes = new Map([['aria-busy', 'true']]);
    const canvas = { dataset: { chartState: 'loading' }, setAttribute: (name, value) => attributes.set(name, value) };
    const status = { textContent: 'Загружаем карту…' };
    let retry, reloads = 0;
    const button = { hidden: true, addEventListener(type, callback) { assert.equal(type, 'click'); retry = callback; } };
    const nodes = { canvasWrap: canvas, chartLoadingStatus: status, chartLoadingRetry: button };
    const document = { hidden: false, getElementById: id => nodes[id] || {} };
    const error = new Error('Startup failed');
    const loadApp = async () => {
      if (failure === 'import') throw error;
      return { startApp() { throw error; } };
    };
    await run(document, class { observe() {} disconnect() {} }, () => ({}), () => ({}), () => () => {},
      () => ({ read: () => null }), loadApp, { reload() { reloads++; } });
    assert.equal(canvas.dataset.chartState, 'error');
    assert.equal(attributes.get('aria-busy'), 'false');
    assert.equal(status.textContent, 'Не удалось загрузить приложение');
    assert.equal(button.hidden, false);
    assert.equal(reloads, 0, 'a startup failure must not create an automatic reload loop');
    retry();
    assert.equal(reloads, 1);
  });
}
