import type { IncomingMessage, ServerResponse, OutgoingHttpHeaders } from 'node:http';

export class HttpInputError extends Error {
  code: string; status: number;
  constructor(code: string, status: number) { super(code); this.code = code; this.status = status; }
}
export function sendJSON(res: ServerResponse, status: number, body: unknown, headers: OutgoingHttpHeaders = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff', ...headers });
  res.end(JSON.stringify(body));
}
export async function readJSONObject(req: IncomingMessage, maxBytes: number): Promise<Record<string, unknown>> {
  if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) throw new HttpInputError('content_type', 415);
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > maxBytes) throw new HttpInputError('too_large', 413);
    chunks.push(bytes);
  }
  let value: unknown;
  try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new HttpInputError('invalid_json', 400); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpInputError('invalid_request', 400);
  return value as Record<string, unknown>;
}
