/** Optional stand gate at the request boundary. Ready caches never pass here. */
export type ConnectionMode = 'online' | 'offline' | 'server';
export interface ConnectionSource {
  readonly current: ConnectionMode;
  subscribe(listener: (mode: ConnectionMode) => void): () => void;
}
export class ConnectionError extends Error {
  code: 'offline' | 'server_unavailable' | 'connection_failed';
  constructor(code: 'offline' | 'server_unavailable' | 'connection_failed') {
    super(code === 'offline' ? 'Нет соединения' : code === 'server_unavailable' ? 'Сервер не отвечает' : 'Нет связи с сервером');
    this.name = 'ConnectionError'; this.code = code;
  }
}
interface TransportOptions { connection: ConnectionSource; fetch?: typeof globalThis.fetch }
export function createHttpTransport({ connection, fetch: send = (...args) => globalThis.fetch(...args) }: TransportOptions): typeof globalThis.fetch {
  return async (input, options = {}) => {
    const sourceSignal = options.signal ?? (input instanceof Request ? input.signal : undefined);
    if (sourceSignal?.aborted) throw sourceSignal.reason;
    if (connection.current !== 'online') throw new ConnectionError(connection.current === 'offline' ? 'offline' : 'server_unavailable');
    const controller = new AbortController();
    let stopped = false, unsubscribe = () => {}, reject!: (reason: unknown) => void;
    const interrupted = new Promise<never>((_, no) => reject = no);
    // An interruption may arrive between headers and the caller reading the body.
    interrupted.catch(() => {});
    const stop = () => { if (stopped) return; stopped = true; unsubscribe(); sourceSignal?.removeEventListener('abort', abort); };
    const fail = (reason: unknown) => { controller.abort(reason); reject(reason); stop(); };
    const abort = () => fail(sourceSignal!.reason);
    sourceSignal?.addEventListener('abort', abort, { once: true });
    unsubscribe = connection.subscribe(mode => { if (mode !== 'online') fail(new ConnectionError(mode === 'offline' ? 'offline' : 'server_unavailable')); });
    try {
      const response = await Promise.race([send(input, { ...options, signal: controller.signal }), interrupted]);
      // All clients consume one of these body readers. Keep the gate alive until
      // bytes are consumed, so a lost connection cannot publish a late result.
      for (const method of ['json', 'text', 'arrayBuffer', 'blob', 'formData'] as const) {
        const read = response[method].bind(response);
        Object.defineProperty(response, method, { configurable: true, value: async () => {
          try { return await Promise.race([read(), interrupted]); } finally { stop(); }
        } });
      }
      return response;
    } catch (error) { stop(); throw error; }
  };
}
let simulation: typeof globalThis.fetch | null = null;
let connectionSource: ConnectionSource | null = null;
export function configureTransportSimulation(connection: ConnectionSource | null, fetch?: typeof globalThis.fetch) {
  connectionSource = connection;
  simulation = connection ? createHttpTransport({ connection, fetch }) : null;
}
export const fetchResource: typeof globalThis.fetch = (input, options) => simulation ? simulation(input, options) : globalThis.fetch(input, options);

export function getConnectionMode(): ConnectionMode {
  return connectionSource?.current ?? (typeof navigator !== 'undefined' && navigator.onLine === false ? 'offline' : 'online');
}
export function subscribeConnection(listener: (mode: ConnectionMode) => void): () => void {
  if (connectionSource) return connectionSource.subscribe(listener);
  const update = () => listener(getConnectionMode()); update();
  if (typeof window === 'undefined') return () => {};
  window.addEventListener('online', update); window.addEventListener('offline', update);
  return () => { window.removeEventListener('online', update); window.removeEventListener('offline', update); };
}

export interface HttpResponseError extends Error { code?: string; status?: number; choices?: unknown; details?: unknown }
/** Retain the server's reason and status. The UI chooses its own short wording. */
export function responseError(status: number | undefined, payload: unknown, fallback: string): HttpResponseError {
  const data = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload as Record<string, unknown> : null;
  const code = typeof data?.error === 'string' && data.error.trim() ? data.error : (status ?? 0) >= 500 ? 'server_error' : 'request_failed';
  const message = typeof data?.message === 'string' && data.message.trim() ? data.message : fallback;
  return Object.assign(new Error(message), { code, status, choices: data?.choices, details: payload });
}
