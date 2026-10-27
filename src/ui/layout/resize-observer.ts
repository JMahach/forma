interface LayoutObserverOptions {
  Observer?: typeof ResizeObserver;
  requestFrame?: (callback: FrameRequestCallback) => number;
  cancelFrame?: (handle: number) => void;
}

/** Measure and write layout outside resize delivery, once per animation frame. */
export function createLayoutObserver(refresh: () => void, {
  Observer = globalThis.ResizeObserver,
  requestFrame = callback => globalThis.requestAnimationFrame(callback),
  cancelFrame = handle => globalThis.cancelAnimationFrame(handle),
}: LayoutObserverOptions = {}) {
  let frame: number | null = null, closed = false;
  const observer = new Observer(() => {
    if (closed || frame !== null) return;
    frame = requestFrame(() => { frame = null; if (!closed) refresh(); });
  });
  return {
    observe: observer.observe.bind(observer),
    disconnect() {
      closed = true; observer.disconnect();
      if (frame !== null) cancelFrame(frame);
      frame = null;
    },
  };
}
