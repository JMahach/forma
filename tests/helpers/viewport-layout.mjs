import { createViewport } from '../../src/ui/layout/viewport.js';

// A full-page surface for the small DOM fixtures. Bounds and keyboard policy
// still come from the real viewport owner, not a second test implementation.
export function createViewportLayout(document) {
  const subscribers = new Set(), window = document.defaultView;
  const surface = { ownerDocument: document, getBoundingClientRect: () => ({
    left: 0, top: 0, width: window.innerWidth, height: window.innerHeight,
  }) };
  const viewport = createViewport({ surface, onChange: () => {
    for (const notify of [...subscribers]) notify();
  } });
  return {
    readViewport: viewport.read,
    subscribeViewport(callback) { subscribers.add(callback); return () => subscribers.delete(callback); },
    get subscriberCount() { return subscribers.size; },
    destroy() { subscribers.clear(); viewport.destroy(); },
  };
}
