import type { IncomingMessage, ServerResponse } from 'node:http';

// A disconnected HTTP consumer stops waiting. The service decides whether its
// shared job is abandoned; it never cancels a neighbour's request.
export function requestSignal(req: IncomingMessage, res: ServerResponse) {
  const controller = new AbortController();
  const disconnect = () => { if (!res.writableEnded) controller.abort(); };
  req.once?.('aborted', disconnect); res.once?.('close', disconnect);
  if (req.aborted || res.destroyed) controller.abort();
  return { signal: controller.signal, close() { req.removeListener?.('aborted', disconnect); res.removeListener?.('close', disconnect); } };
}
