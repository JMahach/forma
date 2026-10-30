type Release = () => unknown;

/** Resources belong to one runtime. Closing is synchronous at the boundary;
 * its promise waits for the owners that also have asynchronous cleanup. */
export function createResourceScope() {
 const controller = new AbortController(), releases = new Set<Release>();
 let closing: Promise<void> | undefined;
 function own(release: Release) {
  if (controller.signal.aborted) return release();
  releases.add(release);
 }
 function stop(): Promise<void> {
  if (controller.signal.aborted) return closing ?? Promise.resolve();
  controller.abort();
  const pending = [...releases].reverse().map(release => {
   try { return Promise.resolve(release()); } catch (error) { return Promise.reject(error); }
  });
  releases.clear();
  closing = Promise.allSettled(pending).then(results => {
   const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
   if (errors.length) throw new AggregateError(errors, 'Runtime cleanup failed');
  });
  return closing;
 }
 return { own, stop, signal: controller.signal, get stopped() { return controller.signal.aborted; } };
}
