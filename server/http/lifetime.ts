import { reportServerFailure, type ServerFailureReport } from '../journal/report.ts';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { LifetimeService } from '../services/lifetime.ts';
import { requestSignal } from './request-signal.ts';
import { LifetimeError } from '../services/lifetime.ts';

const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
function json(res: ServerResponse, status: number, value: unknown) {
  const body = JSON.stringify(value);
  res.writeHead(status, { ...headers,
    'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

export function createLifetimeHandler(service?: Pick<LifetimeService, 'getMetadata' | 'getMoment'>, {report}: {report?:ServerFailureReport} = {}) {
  return async function handle(req: IncomingMessage, res: ServerResponse, suppliedUrl?: URL) {
    if (req.method !== 'GET') { res.writeHead(405, { ...headers, Allow: 'GET' }); res.end(); return; }
    const consumer = requestSignal(req, res);
    try {
      if (!service) throw new LifetimeError('lifetime_unavailable', 'Данные летописи недоступны.');
      const url = suppliedUrl || new URL(req.url!, 'http://localhost');
      if (url.pathname === '/api/lifetime/meta') {
        if (url.searchParams.size) throw new LifetimeError('invalid_request', 'Некорректный запрос шкалы.', 400);
        const meta = await service.getMetadata();
        if (!consumer.signal.aborted) json(res, 200, meta); return;
      }
      if (url.pathname !== '/api/lifetime') throw new LifetimeError('not_found', 'Страница не найдена.', 404);
      const values = url.searchParams.getAll('index');
      if (values.length !== 1 || url.searchParams.size !== 1
          || !/^(?:0|[1-9]\d{0,15})$/.test(values[0])) {
        throw new LifetimeError('invalid_index', 'Выберите момент в пределах шкалы.', 400);
      }
      const value = await service.getMoment(Number(values[0]), { signal: consumer.signal });
      if (consumer.signal.aborted) return;
      json(res, 200, value);
    } catch (error) {
      if (consumer.signal.aborted) return;
      const known = error instanceof LifetimeError;
      if (!known) reportServerFailure(report,{event:'http_request_failed',component:'lifetime',reason:'unexpected'});
      json(res, known ? error.status : 500, { error: known ? error.code : 'internal_error',
        message: known ? error.message : 'Данные летописи недоступны.' });
    } finally { consumer.close(); }
  };
}
