/** Stand-only hold before sending a calculation. It never invents a result. */
export function createCalculationPreview(send: typeof globalThis.fetch = (...args) => globalThis.fetch(...args), canHold = () => true) {
  let waiting = false;
  const pending = new Set<() => void>();
  const request: typeof globalThis.fetch = (input, options = {}) => {
    const source = input instanceof Request ? input.url : String(input);
    const method = options.method || (input instanceof Request ? input.method : 'GET');
    if (!waiting || !canHold() || method.toUpperCase() !== 'POST' || new URL(source, 'http://stand.invalid').pathname !== '/api/calculate') return send(input, options);
    const signal = options.signal ?? (input instanceof Request ? input.signal : undefined);
    return new Promise<Response>((_resolve, reject) => {
      const cancel = () => { pending.delete(cancel); signal?.removeEventListener('abort', cancel); reject(signal?.reason ?? new DOMException('Calculation preview cancelled', 'AbortError')); };
      if (signal?.aborted) { cancel(); return; }
      pending.add(cancel); signal?.addEventListener('abort', cancel, {once:true});
    });
  };
  return { get waiting() { return waiting; }, setWaiting(value: boolean) {
    waiting = value;
    // Leaving the preview cancels it; it must never release a real calculation.
    if (!waiting) for (const cancel of [...pending]) cancel();
  }, fetch: request };
}
