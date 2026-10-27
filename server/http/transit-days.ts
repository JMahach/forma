import { reportServerFailure, type ServerFailureReport } from '../journal/report.ts';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { TransitDays } from '../services/transit-days.ts';
import { requestSignal } from './request-signal.ts';
import { TRANSIT_DAY_VERSION } from '../../shared/day-packets/transit-format.ts';
import { TransitDayError, transitDateMilliseconds } from '../services/transit-days.ts';
import { negotiateEncoding } from './content-encoding.ts';
const DAY_MS = 86400000;
const utcDate = (moment: Date) => new Date(moment).toISOString().slice(0, 10);

export function validateTransitDayQuery(searchParams: URLSearchParams, now = new Date()) {
  const version = searchParams.get('v');
  if (version !== null && version !== TRANSIT_DAY_VERSION) throw new TransitDayError('unsupported_version', 'Версия дневного транзита не поддерживается.', 400, null);
  const date = searchParams.get('date'), value = transitDateMilliseconds(date);
  const today = Date.parse(`${utcDate(now)}T00:00:00Z`);
  return { date: date!, allowCalculate: Math.abs(value - today) <= 2 * DAY_MS };
}

export function createTransitDayHandler({ get, calculationVersion = null }: Pick<TransitDays, 'get'> & { calculationVersion?: string | null }, { now = () => new Date(), report }: {now?:()=>Date;report?:ServerFailureReport} = {}) {
  return async function handle(req: IncomingMessage, res: ServerResponse, url: URL) {
    if (!['GET', 'HEAD'].includes(req.method!)) { res.writeHead(405, { Allow: 'GET, HEAD', 'Cache-Control': 'no-store' }); res.end(); return; }
    const consumer = requestSignal(req, res);
    try {
      const { date, allowCalculate } = validateTransitDayQuery(url.searchParams, now());
      const revision = url.searchParams.get('r');
      if (revision !== null && revision !== calculationVersion) throw new TransitDayError('unsupported_version', 'Версия дневного транзита не поддерживается.', 409, null);
      const encoding = negotiateEncoding(req.headers['accept-encoding']);
      if (!encoding) throw new TransitDayError('encoding_not_acceptable', 'Нет поддерживаемого способа передачи дневного транзита.', 406, null);
      const packet = await get(date, { allowCalculate, signal: consumer.signal });
      if (consumer.signal.aborted) return;
      const body = packet.bytes[encoding];
      const headers = { 'Content-Type': 'application/octet-stream', 'Content-Length': body.length,
        'Cache-Control': 'no-store',
        Vary: 'Accept-Encoding', 'X-Content-Type-Options': 'nosniff',
        ...(encoding === 'identity' ? {} : { 'Content-Encoding': encoding }) };
      res.writeHead(200, headers);
      res.end(req.method === 'HEAD' ? undefined : body);
    } catch (error) {
      if (consumer.signal.aborted) return;
      const known = error instanceof TransitDayError;
      if (!known) reportServerFailure(report,{event:'http_request_failed',component:'transit_day',reason:'unexpected'});
      res.writeHead(known ? error.status : 503, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
        ...(known && error.retryAfter === null ? {} : { 'Retry-After': String(known ? error.retryAfter : 5) }) });
      res.end(req.method === 'HEAD' ? undefined : JSON.stringify({ error: known ? error.code : 'transit_unavailable', message: known ? error.message : 'Не удалось подготовить дневной транзит. Повторите попытку.' }));
    } finally { consumer.close(); }
  }
}
