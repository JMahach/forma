import test from 'node:test';
import assert from 'node:assert/strict';
import { attachChartLoading } from '../src/views/chart-loading.js';

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
  assert.equal(h.canvas.inert, !accessible);
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
