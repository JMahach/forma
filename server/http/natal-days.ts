import { reportServerFailure, type ServerFailureReport } from '../journal/report.ts';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { NatalDays } from '../services/natal-days.ts';
import type { CityCatalog } from '../services/cities.ts';
import { NATAL_DAY_VERSION } from '../../shared/day-packets/natal-format.ts';
import { NatalDayError, validateNatalDayDate, validateNatalZone } from '../services/natal-days.ts';
import { negotiateEncoding } from './content-encoding.ts';
type DayPacket=Awaited<ReturnType<NatalDays['get']>>;
import type {OutgoingHttpHeaders} from 'node:http';

export function sendNatalDayPacket(res:ServerResponse,packet:DayPacket,encoding:keyof DayPacket['bytes'],headers:OutgoingHttpHeaders) {
  const body=packet.bytes[encoding];
  res.writeHead(200,{...headers,'Content-Type':'application/octet-stream','Content-Length':body.length,Vary:'Accept-Encoding',
    ...(encoding==='identity'?{}:{'Content-Encoding':encoding})});
  res.end(body);
}

export function validateNatalDayRequest(value: unknown, cities: CityCatalog) {
  const input = value as { v?: string; birthDate?: unknown; cityId?: unknown } | null;
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new NatalDayError('invalid_request', 'Некорректные данные.', 400, null);
  if (input.v !== NATAL_DAY_VERSION) throw new NatalDayError('unsupported_version', 'Версия дня рождения не поддерживается. Обновите страницу.', 400, null);
  validateNatalDayDate(input.birthDate);
  const city = typeof input.cityId === 'string' && input.cityId.length <= 40 ? cities.find(input.cityId) : null;
  if (!city) throw new NatalDayError('city_required', 'Выберите город из списка подсказок.', 422, null);
  validateNatalZone(city.timezone);
  return { date: input.birthDate, timezone: city.timezone };
}
export function createNatalDayHandler({ get }: Pick<NatalDays, 'get'>, {report}: {report?:ServerFailureReport} = {}) {
  return async function handle(req: IncomingMessage, res: ServerResponse, cities: CityCatalog) {
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
      if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) throw new NatalDayError('content_type', 'Нужны данные JSON.', 415, null);
      const chunks = []; let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 1024) throw new NatalDayError('too_large', 'Слишком большой запрос.', 413, null);
        chunks.push(chunk);
      }
      if (controller.signal.aborted) return;
      let input;
      try { input = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { throw new NatalDayError('invalid_json', 'Не удалось прочитать данные.', 400, null); }
      const { date, timezone } = validateNatalDayRequest(input, cities);
      const encoding = negotiateEncoding(req.headers['accept-encoding']);
      if (!encoding) throw new NatalDayError('encoding_not_acceptable', 'Нет поддерживаемого способа передачи дня рождения.', 406, null);
      const packet = await get(date, timezone, { signal: controller.signal });
      if (controller.signal.aborted) return;
      sendNatalDayPacket(res,packet,encoding,headers);
    } catch (error) {
      if (controller.signal.aborted) return;
      const known = error instanceof NatalDayError;
      if (!known) reportServerFailure(report,{event:'http_request_failed',component:'natal_day',reason:'unexpected'});
      res.writeHead(known ? error.status : 500, { ...headers, 'Content-Type': 'application/json; charset=utf-8',
        ...(known && error.retryAfter !== null ? { 'Retry-After': String(error.retryAfter) } : {}) });
      res.end(JSON.stringify({ error: known ? error.code : 'internal_error', message: known ? error.message : 'Не удалось подготовить день рождения. Повторите попытку.' }));
    } finally { res.removeListener?.('close', disconnect); }
  }
}
