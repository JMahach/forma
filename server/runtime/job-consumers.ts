export interface SharedJob<T> {
  promise: Promise<T>;
  waiters?: Set<object>;
  uncancellable?: boolean;
}

export const aborted = () => new DOMException('Запрос отменён.', 'AbortError');

// A shared job belongs to its service. Each HTTP request/warmup owns only one
// wait; leaving must not reject the result for another user.
export function consumeJob<T, Job extends object>(job: Job & SharedJob<T>, signal?: AbortSignal, onAbandoned: (job: Job & SharedJob<T>) => void = () => {}): Promise<T> {
  if (signal?.aborted) return Promise.reject(aborted());
  if (!signal) { job.uncancellable = true; return job.promise; }
  job.waiters ||= new Set();
  const consumer = {}; job.waiters.add(consumer);
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    function finish<Value>(callback: (value: Value) => void, value: Value) {
      if (settled) return;
      settled = true; job.waiters!.delete(consumer); signal?.removeEventListener('abort', cancel); callback(value);
    }
    function cancel() { finish(reject, aborted()); if (!job.waiters!.size && !job.uncancellable) onAbandoned(job); }
    signal?.addEventListener('abort', cancel, { once: true });
    job.promise.then(value => finish(resolve, value), error => finish(reject, error));
    if (signal?.aborted) cancel();
  });
}
