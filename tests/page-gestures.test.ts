import test from 'node:test';
import assert from 'node:assert/strict';
import { attachPageGestures } from '../src/ui/page-gestures.ts';

function browserEvent(type: {}, { cancelable = true, ...properties } = {}) {
  return Object.assign(new Event(type, { bubbles: true, cancelable }), {
    ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...properties,
  });
}

function dispatch(document: EventTarget, type: string, properties: { cancelable?: boolean|undefined; }|{ readonly deltaY: 80; readonly deltaX?: undefined; readonly shiftKey?: undefined; }|{ readonly deltaY: -80; readonly deltaX?: undefined; readonly shiftKey?: undefined; }|{ readonly deltaX: 80; readonly deltaY?: undefined; readonly shiftKey?: undefined; }|{ readonly deltaY: 80; readonly shiftKey: true; readonly deltaX?: undefined; }|{ key: string; }|undefined) {
  const event = browserEvent(type, properties);
  document.dispatchEvent(event);
  return event;
}

test('Ctrl and Meta wheel cancel page zoom while the chart can still receive the event', () => {
  const document = new EventTarget();
  attachPageGestures(document);
  const received: unknown[] = [];
  document.addEventListener('wheel', event => received.push(event));
  for (const modifier of ['ctrlKey', 'metaKey'] as const) {
    const event = browserEvent('wheel', { [modifier]: true, deltaY: -80 });
    let stopped = 0;
    event.stopPropagation = () => { stopped++; };
    event.stopImmediatePropagation = () => { stopped++; };
    document.dispatchEvent(event);
    assert.equal(event.defaultPrevented, true, modifier);
    assert.equal(stopped, 0, 'chart handlers must remain reachable');
    assert.equal(received.at(-1), event);
  }
});

test('ordinary wheel keeps native menu scrolling available in either direction', () => {
  const document = new EventTarget();
  attachPageGestures(document);
  for (const delta of [{ deltaY: 80 }, { deltaY: -80 }, { deltaX: 80 }, { deltaY: 80, shiftKey: true }] as const) {
    assert.equal(dispatch(document, 'wheel', delta).defaultPrevented, false);
  }
});

test('every Safari gesture phase cancels only the browser default', () => {
  const document = new EventTarget();
  attachPageGestures(document);
  for (const type of ['gesturestart', 'gesturechange', 'gestureend'] as const) {
    const event = browserEvent(type, { scale: 1.3 });
    let stopped = 0;
    event.stopPropagation = () => { stopped++; };
    event.stopImmediatePropagation = () => { stopped++; };
    document.dispatchEvent(event);
    assert.equal(event.defaultPrevented, true, type);
    assert.equal(stopped, 0, 'the scene can consume the same gesture');
  }
});

test('browser zoom shortcuts cancel page zoom without swallowing chart key handling', () => {
  const document = new EventTarget();
  attachPageGestures(document);
  const received: unknown[] = [];
  document.addEventListener('keydown', event => received.push(event));
  for (const modifier of ['ctrlKey', 'metaKey'] as const) {
    for (const key of ['+', '=', '-', '_', '0'] as const) {
      const event = browserEvent('keydown', { key, [modifier]: true });
      let stopped = 0;
      event.stopPropagation = () => { stopped++; };
      event.stopImmediatePropagation = () => { stopped++; };
      document.dispatchEvent(event);
      assert.equal(event.defaultPrevented, true, `${modifier} ${key}`);
      assert.equal(stopped, 0);
      assert.equal(received.at(-1), event);
    }
  }
});

test('typing, editing shortcuts, navigation and AltGr remain native', () => {
  const document = new EventTarget();
  attachPageGestures(document);
  const keys = [
    ...['+', '=', '-', '_', '0'].map(key => ({ key })),
    { key: '+', shiftKey: true },
    { key: 'c', ctrlKey: true }, { key: 'a', ctrlKey: true },
    { key: 'v', metaKey: true }, { key: 'a', metaKey: true },
    { key: 'ArrowLeft', ctrlKey: true }, { key: 'ArrowRight', metaKey: true },
    { key: 'ArrowDown' }, { key: 'Tab' }, { key: 'Escape' },
    ...['+', '=', '-', '_', '0'].map(key => ({ key, ctrlKey: true, altKey: true })),
  ];
  for (const properties of keys) {
    assert.equal(dispatch(document, 'keydown', properties).defaultPrevented, false, JSON.stringify(properties));
  }
});

test('touch input remains available to native scroll and the scene pointer gestures', () => {
  const document = new EventTarget();
  attachPageGestures(document);
  for (const type of ['touchstart', 'touchmove', 'touchend'] as const) {
    assert.equal(dispatch(document, type, { touches: [{}, {}] }).defaultPrevented, false, type);
  }
});

test('uncancelable browser events do not receive a cancellation attempt', () => {
  const document = new EventTarget();
  attachPageGestures(document);
  const events = [
    ['wheel', { ctrlKey: true }], ['keydown', { key: '+', ctrlKey: true }],
    ['gesturestart', {}], ['gesturechange', {}], ['gestureend', {}],
  ];
  for (const [type, properties] of events) {
    const event = browserEvent(type, { ...properties, cancelable: false });
    let attempts = 0;
    event.preventDefault = () => { attempts++; };
    document.dispatchEvent(event);
    assert.equal(attempts, 0, type);
  }
});

test('native zoom is guarded during capture with cancellable wheel and gesture listeners', () => {
  const document = new EventTarget(), subscriptions: { type: string; options: boolean|AddEventListenerOptions|undefined; }[] = [];
  const add = document.addEventListener.bind(document);
  document.addEventListener = (type, callback, options) => {
    subscriptions.push({ type, options });
    add(type, callback, options);
  };
  attachPageGestures(document);
  for (const type of ['wheel', 'gesturestart', 'gesturechange', 'gestureend'] as const) {
    const subscription = subscriptions.find(item => item.type === type);
    assert.ok(subscription, type);
    assert.equal(subscription.options!.capture, true, type);
    assert.equal(subscription.options!.passive, false, type);
  }
  assert.equal(subscriptions.find(item => item.type === 'keydown')!?.options!.capture, true);
  assert.equal(subscriptions.some(item => item.type.startsWith('touch')), false);
});
