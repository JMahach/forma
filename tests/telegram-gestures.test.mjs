import test from 'node:test';
import assert from 'node:assert/strict';
import { attachTelegramGestures } from '../src/ui/telegram-gestures.js';

function surface() {
  const listeners = new Map(), registrations = [];
  return {
    registrations,
    addEventListener(type, listener, options) {
      registrations.push({ type, listener, options });
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(listener);
    },
    removeEventListener(type, listener) { listeners.get(type)?.delete(listener); },
    emit(type, touches = []) {
      const interceptions = [];
      const event = {
        type, target: this, touches,
        preventDefault() { interceptions.push('preventDefault'); },
        stopPropagation() { interceptions.push('stopPropagation'); },
        stopImmediatePropagation() { interceptions.push('stopImmediatePropagation'); },
      };
      for (const listener of listeners.get(type) || []) listener(event);
      assert.deepEqual(interceptions, [], 'native behavior and other chart/range handlers remain available');
    },
  };
}

function bridge() {
  const calls = [];
  const proxy = {
    postEvent(name, data) {
      assert.equal(this, proxy, 'preserve the bridge method receiver');
      calls.push({ name, data });
    },
  };
  return {
    calls,
    host: {
      TelegramWebviewProxy: proxy,
      webkit: { messageHandlers: { performAction: {
        postMessage() { assert.fail('send through the Telegram proxy'); },
      } } },
      addEventListener() { assert.fail('do not listen to gestures globally'); },
    },
  };
}

test('an ordinary browser keeps touches, native range input and clicks untouched', () => {
  const graph = surface(), range = surface();
  const cleanup = attachTelegramGestures([graph, range], { host: {} });
  for (const element of [graph, range]) {
    for (const type of ['touchstart', 'touchmove', 'touchend', 'click', 'input']) {
      assert.doesNotThrow(() => element.emit(type));
    }
  }
  assert.doesNotThrow(cleanup);
});

test('each supplied SVG and range preserves drags in all directions and a pinch', () => {
  const elements = [surface(), surface(), surface()], { host, calls } = bridge();
  attachTelegramGestures(elements, { host });
  const positions = [
    [{ identifier: 1, clientX: 100, clientY: 100 }],
    [{ identifier: 1, clientX: 120, clientY: 100 }],
    [{ identifier: 1, clientX: 80, clientY: 100 }],
    [{ identifier: 1, clientX: 100, clientY: 80 }],
    [{ identifier: 1, clientX: 100, clientY: 120 }],
    [{ identifier: 1, clientX: 80, clientY: 80 }, { identifier: 2, clientX: 120, clientY: 120 }],
  ];
  for (const element of elements) {
    for (const touches of positions) element.emit('touchmove', touches);
  }
  assert.equal(calls.length, elements.length * positions.length);
  for (const call of calls) assert.deepEqual(call, { name: 'cancellingTouch', data: {} });
});

test('listeners are passive, scoped to supplied surfaces and ignore non-move events', () => {
  const graph = surface(), range = surface(), elsewhere = surface(), { host, calls } = bridge();
  attachTelegramGestures([graph, range], { host });
  for (const element of [graph, range]) {
    assert.equal(element.registrations.length, 1);
    assert.equal(element.registrations[0].type, 'touchmove');
    assert.equal(element.registrations[0].options.passive, true);
    for (const type of ['touchstart', 'touchend', 'touchcancel', 'click', 'pointermove', 'input']) element.emit(type);
  }
  elsewhere.emit('touchmove');
  assert.deepEqual(calls, []);
  graph.emit('touchmove');
  assert.equal(calls.length, 1);
});

test('cleanup removes cancellation from every supplied surface', () => {
  const elements = [surface(), surface(), surface()], { host, calls } = bridge();
  const cleanup = attachTelegramGestures(elements, { host });
  for (const element of elements) element.emit('touchmove');
  assert.equal(calls.length, 3);
  cleanup();
  for (const element of elements) element.emit('touchmove');
  assert.equal(calls.length, 3);
  assert.doesNotThrow(cleanup);
});

test('missing or incompatible native and Telegram bridges never cancel or break movement', () => {
  const { host: compatible } = bridge();
  const hosts = [
    {},
    { webkit: compatible.webkit },
    { TelegramWebviewProxy: compatible.TelegramWebviewProxy },
    { ...compatible, webkit: { messageHandlers: {} } },
    { ...compatible, webkit: { messageHandlers: { performAction: { postMessage: true } } } },
    { ...compatible, TelegramWebviewProxy: null },
    { ...compatible, TelegramWebviewProxy: { postEvent: true } },
  ];
  let cancellations = 0;
  compatible.TelegramWebviewProxy.postEvent = () => { cancellations++; };
  for (const host of hosts) {
    const element = surface();
    const cleanup = attachTelegramGestures([element], { host });
    assert.doesNotThrow(() => element.emit('touchmove'));
    cleanup();
  }
  assert.equal(cancellations, 0);
});

test('a bridge failure leaves gestures working and a later healthy call can recover', () => {
  const element = surface(), { host, calls } = bridge();
  const postEvent = host.TelegramWebviewProxy.postEvent;
  host.TelegramWebviewProxy.postEvent = () => { throw new Error('host bridge unavailable'); };
  attachTelegramGestures([element], { host });
  assert.doesNotThrow(() => element.emit('touchmove'));
  host.TelegramWebviewProxy.postEvent = postEvent;
  element.emit('touchmove');
  assert.deepEqual(calls, [{ name: 'cancellingTouch', data: {} }]);
});

test('bridge availability is checked when moving, including late injection and disappearance', () => {
  const element = surface(), host = {}, { host: compatible, calls } = bridge();
  attachTelegramGestures([element], { host });
  element.emit('touchmove');
  assert.deepEqual(calls, []);
  Object.assign(host, compatible);
  element.emit('touchmove');
  assert.equal(calls.length, 1);
  delete host.webkit;
  assert.doesNotThrow(() => element.emit('touchmove'));
  assert.equal(calls.length, 1);
});

test('optional absent surfaces and repeated elements do not create duplicate bridge signals', () => {
  const element = surface(), { host, calls } = bridge();
  const cleanup = attachTelegramGestures([element, null, element, undefined], { host });
  assert.equal(element.registrations.length, 1);
  element.emit('touchmove');
  assert.equal(calls.length, 1);
  cleanup();
  element.emit('touchmove');
  assert.equal(calls.length, 1);
});
