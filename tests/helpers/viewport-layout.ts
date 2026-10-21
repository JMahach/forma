import type { DateDocument } from './date-dom.ts';
import { createViewport } from '../../src/ui/layout/viewport.ts';

// A full-page surface for the small DOM fixtures. Bounds and keyboard policy
// still come from the real viewport owner, not a second test implementation.
export function createViewportLayout(fixture: Document | DateDocument) {
  const document = fixture as Document;
  const subscribers = new Set<() => void>(), window = document.defaultView!;
  const surface = { ownerDocument: document, getBoundingClientRect: () => ({
    left: 0, top: 0, width: window.innerWidth, height: window.innerHeight,
  }) };
  const viewport = createViewport({ surface: surface as unknown as HTMLElement, onChange: () => {
    for (const notify of [...subscribers] as const) notify();
  } });
  return {
    readViewport: viewport.read,
    subscribeViewport(callback: () => void) { subscribers.add(callback); return () => subscribers.delete(callback); },
    get subscriberCount() { return subscribers.size; },
    destroy() { subscribers.clear(); viewport.destroy(); },
  };
}
