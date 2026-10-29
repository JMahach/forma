import type { createReturnReceipts } from '../services/return-receipt.ts';
import { reportServerFailure, type ServerFailureReport } from '../journal/report.ts';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Cycles } from '../services/cycles.ts';
import { CycleError, validateCycleRequest } from '../services/cycles.ts';

export function createCyclesHandler(service: Pick<Cycles, 'events' | 'chart'>, {report,issueReceipt}: {report?:ServerFailureReport;issueReceipt?:ReturnType<typeof createReturnReceipts>['issue']} = {}) {
  return async function handle(req: IncomingMessage, res: ServerResponse, url: URL) {
    const headers = { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' };
    if (req.method !== 'POST') { res.writeHead(405, { ...headers, Allow: 'POST' }); res.end(); return; }
    const controller = new AbortController();
    const disconnect = () => {
      if (res.writableEnded) return;
      controller.abort();
      if (!req.complete) req.destroy?.();
    };
    res.once?.('close', disconnect);
    if (res.destroyed) disconnect();
    try {
      if (controller.signal.aborted) return;
      const action = url.pathname === '/api/cycles/events' ? 'events' : url.pathname === '/api/cycles/chart' ? 'chart' : null;
      if (!action) throw new CycleError('invalid_request', 'Неизвестный режим циклов.', 404, null);
      if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) throw new CycleError('content_type', 'Нужны данные JSON.', 415, null);
      const chunks = []; let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 2048) throw new CycleError('too_large', 'Слишком большой запрос.', 413, null);
        chunks.push(chunk);
      }
      if (controller.signal.aborted) return;
      let input;
      try { input = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { throw new CycleError('invalid_json', 'Не удалось прочитать данные.', 400, null); }
      const request = validateCycleRequest(input, action);
      const result = await service[action](request, { signal: controller.signal });
      if (controller.signal.aborted) return;
      res.writeHead(200, { ...headers, 'Content-Type': 'application/json; charset=utf-8' });
      const proof=issueReceipt?.(action,request,result);
      res.end(JSON.stringify(proof?{...result,proof}:result));
    } catch (error) {
      if (controller.signal.aborted) return;
      const known = error instanceof CycleError;
      if (!known) reportServerFailure(report,{event:'http_request_failed',component:'cycles',reason:'unexpected'});
      res.writeHead(known ? error.status : 503, { ...headers, 'Content-Type': 'application/json; charset=utf-8',
        ...(known && error.retryAfter === null ? {} : { 'Retry-After': String(known ? error.retryAfter : 3) }) });
      res.end(JSON.stringify({ error: known ? error.code : 'cycles_unavailable', message: known ? error.message : 'Не удалось подготовить циклы. Повторите попытку.', ...(known ? error.details : {}) }));
    } finally { res.removeListener?.('close', disconnect); }
  };
}
