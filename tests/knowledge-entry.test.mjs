import test from 'node:test';
import assert from 'node:assert/strict';

function element() {
  const listeners = new Map(), attributes = new Map();
  return {
    addEventListener(type, listener) { listeners.set(type, listener); },
    dispatch(type, event = {}) { return listeners.get(type)?.(event); },
    setAttribute(name, value) { attributes.set(name, value); },
    removeAttribute(name) { attributes.delete(name); },
    hasAttribute(name) { return attributes.has(name); },
  };
}
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const drain = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
async function harness() {
  const { attachKnowledgeEntry } = await import('../src/views/knowledge-entry.js');
  const button = element(), dialog = {}, eventTarget = element(), requests = [], shown = [], errors = [], chosen = [];
  let attached = 0, closed = 0, selection = { type: 'gate', id: 37 };
  const module = { attachKnowledge(received, onSelect) {
    assert.equal(received, dialog); attached++;
    return { show(value) { shown.push(value); }, select: onSelect };
  } };
  const controller = attachKnowledgeEntry({ button, dialog, eventTarget, onSelect: value => chosen.push(value),
    getSelection: () => selection, beforeOpen: () => { closed++; }, onError: message => errors.push(message),
    load() { const request = deferred(); requests.push(request); return request.promise; } });
  return { button, eventTarget, requests, shown, errors, chosen, module, controller,
    setSelection(value) { selection = value; }, get attached() { return attached; }, get closed() { return closed; } };
}

test('Knowledge loads only on first open, shares pending work and reuses one attached dialog', async () => {
  const h = await harness();
  assert.equal(h.requests.length, 0);
  const first = h.button.dispatch('click'); await drain();
  assert.equal(h.button.hasAttribute('aria-busy'), true);
  h.setSelection({ type: 'gate', id: 10 });
  const repeated = h.button.dispatch('click'); await drain();
  assert.equal(h.requests.length, 1);
  h.requests[0].resolve(h.module); await Promise.all([first, repeated]);
  assert.equal(h.attached, 1);
  assert.deepEqual(h.shown, [{ type: 'gate', id: 10 }]);
  assert.equal(h.button.hasAttribute('aria-busy'), false);
  h.setSelection({ type: 'center', id: 'root' }); await h.button.dispatch('click');
  assert.equal(h.requests.length, 1); assert.equal(h.attached, 1);
  assert.deepEqual(h.shown.at(-1), { type: 'center', id: 'root' });
});

test('Escape cancels pending opening without discarding the module or reopening on completion', async () => {
  const h = await harness(); const first = h.button.dispatch('click'); await drain();
  h.eventTarget.dispatch('keydown', { key: 'Escape' });
  assert.equal(h.button.hasAttribute('aria-busy'), false);
  h.requests[0].resolve(h.module); assert.equal(await first, false);
  assert.deepEqual(h.shown, []); assert.equal(h.attached, 1);
  await h.button.dispatch('click'); assert.equal(h.requests.length, 1); assert.equal(h.shown.length, 1);
});

test('reopening before a cancelled import finishes opens exactly once with the latest topic', async () => {
  const h = await harness(); const first = h.button.dispatch('click'); await drain();
  h.eventTarget.dispatch('keydown', { key: 'Escape' });
  h.setSelection({ type: 'channel', id: '37-40' });
  const reopened = h.button.dispatch('click'); await drain();
  h.requests[0].resolve(h.module); await Promise.all([first, reopened]);
  assert.equal(h.requests.length, 1); assert.equal(h.attached, 1);
  assert.deepEqual(h.shown, [{ type: 'channel', id: '37-40' }]);
});

test('a failed import can retry and cancelled failures stay silent', async () => {
  for (const cancelled of [false, true]) {
    const h = await harness(); const first = h.button.dispatch('click'); await drain();
    if (cancelled) h.eventTarget.dispatch('keydown', { key: 'Escape' });
    h.requests[0].reject(new Error('Offline')); assert.equal(await first, false);
    assert.equal(h.button.hasAttribute('aria-busy'), false);
    assert.equal(h.errors.length, cancelled ? 0 : 1); assert.equal(h.attached, 0);
    const retry = h.button.dispatch('click'); await drain();
    assert.equal(h.requests.length, 2); h.requests[1].resolve(h.module);
    assert.equal(await retry, true); assert.equal(h.shown.length, 1); assert.equal(h.attached, 1);
  }
});
