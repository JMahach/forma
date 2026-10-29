import type { ApplicationPorts, RouteRequest } from './ports.ts';

/** Route order lives here; numerical data and presentation remain with their owners. */
export async function prepareRoute(ports: ApplicationPorts, request: RouteRequest, signal: AbortSignal) {
  const current = () => !signal.aborted && ports.navigation.isCurrent(request.snapshot);
  if (!current()) return 'cancelled' as const;
  const route = ports.route(request);
  let disposed = false;
  const dispose = () => { if (!disposed) { disposed = true; route.dispose(); } };
  signal.addEventListener('abort', dispose, {once: true});
  try {
    route.enter();
    await route.prepare(signal, current);
    if (!current()) return 'cancelled' as const;
    route.apply();
    return 'ready' as const;
  } catch (error) {
    if (!current()) return 'cancelled' as const;
    await route.failed(error);
    return 'failed' as const;
  } finally {
    signal.removeEventListener('abort', dispose);
    try { if (current()) route.settled(); } finally { dispose(); }
  }
}
