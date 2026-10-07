export const createAbortError = () => new DOMException('Загрузка отменена.', 'AbortError');

// Clients own the operation and its result. This owner only shares its lifetime:
// each caller can leave independently, and the last caller stops the transport.
// Consumer data stays visible to operations that must validate a shared result.
export function shareRequest(pending, key, start, { signal, consumer = {} } = {}) {
  if (signal?.aborted) return Promise.reject(createAbortError());
  const forget = request => { if (pending.get(key) === request) pending.delete(key); };
  let request = pending.get(key);
  if (!request) {
    request = { controller: new AbortController(), consumers: new Set(), promise: null };
    const owned = request;
    request.promise = (async () => start(owned))().finally(() => forget(owned));
    pending.set(key, request);
  }
  return new Promise((resolve, reject) => {
    request.consumers.add(consumer);
    const release = () => { signal?.removeEventListener('abort', cancel); request.consumers.delete(consumer); };
    const cancel = () => {
      release(); reject(createAbortError());
      if (!request.consumers.size) {
        request.controller.abort();
        forget(request);
      }
    };
    signal?.addEventListener('abort', cancel, { once: true });
    request.promise.then(value => { release(); resolve(value); }, error => { release(); reject(error); });
    if (signal?.aborted) cancel();
  });
}
