import { CHART_DAY_VERSION } from '../../shared/day-packets/natal-format.js';
import { ChartDayError, validateNatalDate, validateNatalZone } from '../services/natal-days.mjs';
import { negotiateEncoding } from './content-encoding.mjs';

export function validateChartDayRequest(input, cities) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ChartDayError('invalid_request', 'Некорректные данные.', 400, null);
  if (input.v !== CHART_DAY_VERSION) throw new ChartDayError('unsupported_version', 'Версия дня рождения не поддерживается. Обновите страницу.', 400, null);
  validateNatalDate(input.birthDate);
  const city = typeof input.cityId === 'string' && input.cityId.length <= 40 ? cities.find(input.cityId) : null;
  if (!city) throw new ChartDayError('city_required', 'Выберите город из списка подсказок.', 422, null);
  validateNatalZone(city.timezone);
  return { date: input.birthDate, timezone: city.timezone };
}
export function createNatalDayHandler({ get }) {
  return async function handle(req, res, cities) {
    const headers = { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' };
    if (req.method !== 'POST') { res.writeHead(405, { ...headers, Allow: 'POST' }); res.end(); return; }
    try {
      if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) throw new ChartDayError('content_type', 'Нужны данные JSON.', 415, null);
      const chunks = []; let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 1024) throw new ChartDayError('too_large', 'Слишком большой запрос.', 413, null);
        chunks.push(chunk);
      }
      let input;
      try { input = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { throw new ChartDayError('invalid_json', 'Не удалось прочитать данные.', 400, null); }
      const { date, timezone } = validateChartDayRequest(input, cities);
      const encoding = negotiateEncoding(req.headers['accept-encoding']);
      if (!encoding) throw new ChartDayError('encoding_not_acceptable', 'Нет поддерживаемого способа передачи дня рождения.', 406, null);
      const packet = await get(date, timezone), body = packet.bytes[encoding];
      res.writeHead(200, { ...headers, 'Content-Type': 'application/octet-stream', 'Content-Length': body.length, Vary: 'Accept-Encoding',
        ...(encoding === 'identity' ? {} : { 'Content-Encoding': encoding }) });
      res.end(body);
    } catch (error) {
      const known = error instanceof ChartDayError;
      res.writeHead(known ? error.status : 503, { ...headers, 'Content-Type': 'application/json; charset=utf-8',
        ...(known && error.retryAfter === null ? {} : { 'Retry-After': String(known ? error.retryAfter : 5) }) });
      res.end(JSON.stringify({ error: known ? error.code : 'chart_day_unavailable', message: known ? error.message : 'Не удалось подготовить день рождения. Повторите попытку.' }));
    }
  }
}
