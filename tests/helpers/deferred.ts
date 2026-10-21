// Controllable work for race/cancellation tests; no timers or production state.
export function deferred<T = unknown>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, reject, resolve: resolve as (...args: undefined extends T
    ? [value?: T | PromiseLike<T>]
    : [value: T | PromiseLike<T>]) => void };
}
