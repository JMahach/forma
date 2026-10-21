import test from 'node:test';
import assert from 'node:assert/strict';
import { attachChartLoading, holdLoadingContent, commitLoadingLayout } from '../src/views/chart-loading.js';

function element() {
  const attributes = new Map(), listeners = new Map();
  return {
    hidden: false, inert: false, dataset: {}, style: {}, textContent: '',
    setAttribute(name, value) { attributes.set(name, String(value)); },
    getAttribute(name) { return attributes.get(name) ?? null; },
    hasAttribute(name) { return attributes.has(name); },
    toggleAttribute(name, enabled) { if (enabled) attributes.set(name, ''); else attributes.delete(name); },
    addEventListener(type, handler) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(handler);
    },
    dispatch(type) { for (const handler of listeners.get(type) || []) handler({ target: this }); },
  };
}

function harness() {
  const elements = Object.fromEntries(['canvas', 'drawing', 'art', 'message', 'status', 'retry', 'heading'].map(name => [name, element()]));
  let retries = 0;
  const loading = attachChartLoading({ ...elements, onRetry: () => { retries++; } });
  return { ...elements, ...loading, get retries() { return retries; } };
}

function assertChartAccessible(h, accessible) {
  assert.equal(h.canvas.inert, false, 'the loading surface remains available to camera gestures');
  assert.equal(h.drawing.inert, !accessible, 'unready chart targets remain inaccessible');
  assert.equal(h.drawing.getAttribute('tabindex'), accessible ? '0' : '-1');
  assert.equal(h.drawing.getAttribute('aria-hidden'), String(!accessible));
  assert.equal(h.art.hasAttribute('hidden'), accessible);
  assert.equal(h.message.hidden, accessible);
  assert.equal(h.heading.style.visibility, accessible ? '' : 'hidden');
}

test('the first ready chart restores keyboard navigation and removes loading presentation', () => {
  const h = harness();
  h.update({ hasChart: false });
  assertChartAccessible(h, false);
  assert.equal(h.canvas.dataset.chartState, 'loading');
  assert.equal(h.canvas.getAttribute('aria-busy'), 'true');
  assert.equal(h.status.textContent, 'Загружаем карту…');
  assert.equal(h.retry.hidden, true);

  h.heading.hidden = true; // Camera chrome can independently hide a zoomed caption.
  h.update({ hasChart: true, loading: true });
  assertChartAccessible(h, true);
  assert.equal(h.canvas.dataset.chartState, 'ready');
  assert.equal(h.canvas.getAttribute('aria-busy'), 'false');
  assert.equal(h.status.textContent, '');
  assert.equal(h.retry.hidden, true);
  assert.equal(h.heading.hidden, true, 'readiness does not override camera-owned caption visibility');
  assert.equal(h.retries, 0, 'presentation never starts a data request');
});

test('failed first load offers retry and returns to loading when its owner restarts the request', () => {
  const h = harness();
  h.update({ hasChart: false, failed: true });
  assertChartAccessible(h, false);
  assert.equal(h.canvas.dataset.chartState, 'error');
  assert.equal(h.canvas.getAttribute('aria-busy'), 'false');
  assert.equal(h.status.textContent, 'Не удалось загрузить карту');
  assert.equal(h.retry.hidden, false);
  h.retry.dispatch('click');
  assert.equal(h.retries, 1);
  assert.equal(h.canvas.dataset.chartState, 'error', 'request ownership stays with the transit controller');

  h.update({ hasChart: false, failed: true, loading: true });
  assertChartAccessible(h, false);
  assert.equal(h.canvas.dataset.chartState, 'loading');
  assert.equal(h.canvas.getAttribute('aria-busy'), 'true');
  assert.equal(h.status.textContent, 'Загружаем карту…');
  assert.equal(h.retry.hidden, true);
  h.update({ hasChart: true });
  assertChartAccessible(h, true);
  assert.equal(h.canvas.dataset.chartState, 'ready');
  assert.equal(h.retries, 1);
});

test('a usable chart stays accessible through partial-day loading or failure; losing it restores the placeholder', () => {
  const h = harness();
  for (const [failed, loading] of [[true, true], [true, false], [false, true], [false, false]]) {
    h.update({ hasChart: true, failed, loading });
    assertChartAccessible(h, true);
    assert.equal(h.canvas.dataset.chartState, 'ready');
    assert.equal(h.canvas.getAttribute('aria-busy'), 'false');
    assert.equal(h.status.textContent, '');
    assert.equal(h.retry.hidden, true);
  }
  h.update({ hasChart: false, failed: true });
  assertChartAccessible(h, false);
  assert.equal(h.canvas.dataset.chartState, 'error');
  assert.equal(h.retry.hidden, false);
});


test('an accepted chart retains the same loading presentation until the whole initial screen can reveal', () => {
  const h = harness();
  h.update({ hasChart: true, holdLoading: true });
  assertChartAccessible(h, false);
  assert.equal(h.canvas.dataset.chartState, 'loading');
  assert.equal(h.status.textContent, 'Загружаем карту…');
  h.update({ hasChart: true, holdLoading: false });
  assertChartAccessible(h, true);
  assert.equal(h.canvas.dataset.chartState, 'ready');
});


test('loading blocks content while retaining panel navigation and releases only its own inert state', () => {
  const nodes = new Map();
  const get = name => { if (!nodes.has(name)) nodes.set(name, element()); return nodes.get(name); };
  const document = { getElementById: get, querySelector: get };
  get('returnsPanel').inert = true;
  get('library').inert = true;
  const release = holdLoadingContent(document);
  for (const id of ['mainNavigation', 'savedChartsSection', 'summaryScreen', 'returnsPanel', 'accountPage', 'knowledgeDialog', 'allChartsDialog',
    'transitControls', 'natalDayControls', 'lifetimeControls', 'togglePerformance']) assert.equal(get(id).inert, true, id);
  assert.equal(get('openLibrary').inert, false);
  assert.equal(get('summarySwitch').inert, false);
  assert.equal(get('.sidebar-footer').inert, false);
  assert.equal(get('.chart-view-tools').inert, false);
  assert.equal(get('toggleLoadingPreview').inert, false);
  release(); release();
  assert.equal(get('mainNavigation').inert, false);
  assert.equal(get('lifetimeControls').inert, false);
  assert.equal(get('returnsPanel').inert, true, 'a prior content restriction remains owned by its feature');
  assert.equal(get('library').inert, true, 'the closed panel keeps its own accessibility restriction');
});


test('initial layout measures both panels, tools and canvas before enabling their transitions', () => {
  const sequence = [];
  const shell = { dataset: new Proxy({ booting: 'true' }, {
    deleteProperty(target, key) { sequence.push(`release:${key}`); return Reflect.deleteProperty(target, key); },
  }) };
  const selectors = ['.library', '.chart-summary', '.chart-view-tools', '.canvas-wrap'];
  const nodes = new Map(selectors.map(selector => [selector, { getBoundingClientRect() {
    assert.equal(shell.dataset.booting, 'true', 'every measurement happens with transitions disabled');
    assert.equal(shell.dataset.shellReady, undefined, 'unprepared controls stay behind the first-paint gate');
    sequence.push(selector); return { width: 296.8 };
  } }]));
  const document = { querySelector: selector => selector === '.app-shell' ? shell : null,
    querySelectorAll: selector => selector.split(',').map(value => nodes.get(value.trim())).filter(Boolean) };
  commitLoadingLayout(document);
  assert.deepEqual(sequence, [...selectors, 'release:booting']);
  assert.equal(shell.dataset.booting, undefined);
  assert.equal(shell.dataset.shellReady, 'true', 'the complete measured shell is revealed together');
  commitLoadingLayout(document);
  assert.deepEqual(sequence, [...selectors, 'release:booting'], 'later reveals do not remeasure or stop interactive movement');
});

test('an interactive shell is never put back into boot mode by a layout commit', () => {
  const shell = { dataset: { booting: 'false' } };
  const document = { querySelector: () => shell,
    querySelectorAll() { assert.fail('ordinary interactive layout does not need a boot commit'); } };
  commitLoadingLayout(document);
  assert.equal(shell.dataset.booting, 'false');
});
