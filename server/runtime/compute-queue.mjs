const aborted = () => new DOMException('Запрос отменён.', 'AbortError');
const busy = () => Object.assign(new Error('Calculation queue is full'), { code: 'busy' });

// The server creates one queue. Only the physical JSON worker takes a slot;
// a chart request, file read or compression never takes a second CPU slot.
export function createComputeQueue({ concurrency = 4, maxQueued = 64 } = {}) {
  let active = 0, accepting = true;
  const queue = [];
  function drain() {
    while (accepting && active < concurrency && queue.length) {
      const priorityOf = job => typeof job.priority === 'function' ? job.priority() : job.priority;
      queue.sort((a, b) => priorityOf(b) - priorityOf(a));
      const job = queue.shift(); job.started = true; active++;
      let work;
      try { work = job.start(); } catch (error) { work = Promise.reject(error); }
      Promise.resolve(work).finally(() => {
        active--; job.signal?.removeEventListener('abort', job.cancel); drain();
      }).then(job.resolve, job.reject);
    }
  }
  return {
    run(start, { signal, priority = 0 } = {}) {
      if (signal?.aborted) return Promise.reject(aborted());
      if (!accepting || active >= concurrency && queue.length >= maxQueued) return Promise.reject(busy());
      return new Promise((resolve, reject) => {
        const job = { start, signal, priority, resolve, reject, started: false, cancel: null };
        job.cancel = () => {
          if (job.started) return; // The worker owns termination and its close event.
          const index = queue.indexOf(job); if (index >= 0) queue.splice(index, 1);
          signal.removeEventListener('abort', job.cancel); reject(aborted());
        };
        signal?.addEventListener('abort', job.cancel, { once: true });
        queue.push(job);
        drain();
      });
    },
    close() { accepting = false; for (const job of queue.splice(0)) { job.signal?.removeEventListener('abort', job.cancel); job.reject(aborted()); } },
    get active() { return active; }, get queued() { return queue.length; },
  };
}
