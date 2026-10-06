import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Run the entry module with its browser ports, leaving its actual initialization
// order intact while replacing the network-loaded application.
const source = readFileSync(new URL('../src/startup.js', import.meta.url), 'utf8')
  .replace(/^import .*;\n/gm, '').replace("import('./app.js')", 'loadApp()');
const run = new (Object.getPrototypeOf(async function () {}).constructor)(
  'document', 'ResizeObserver', 'createTransitDayClient', 'createStudioLayout', 'createToast', 'createViewStore', 'loadApp', source);

test('startup reads the tab once and prefetches only a day that owns the saved view', async () => {
  for (const [savedView, needsDay] of [
    [null, true],
    [{ selectedId: 'current-transit', transit: { live: false } }, true],
    [{ selectedId: 'current-transit', lifetime: { opened: true, mode: 'archive' } }, false],
    [{ selectedId: 'personal' }, false],
    [{ selectedId: 'personal', lifetime: { opened: true, mode: 'archive', personalPreview: true, personalLive: false } }, false],
    [{ selectedId: 'personal', lifetime: { opened: true, mode: 'archive', personalLive: true } }, true],
    [{ selectedId: 'personal', lifetime: { opened: true, mode: 'archive', personalLive: true }, returns: { eventId: 'exact' } }, false],
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
