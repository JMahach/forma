import { TRANSIT_DAY_VERSION } from '../../shared/day-packets/transit-format.js';
import { TransitDayError, transitDateMilliseconds } from '../services/transit-days.mjs';
import { negotiateEncoding } from './content-encoding.mjs';
const DAY_MS = 86400000;
const utcDate = moment => new Date(moment).toISOString().slice(0, 10);

export function validateTransitDayQuery(searchParams, now = new Date()) {
  const version = searchParams.get('v');
  if (version !== null && version !== TRANSIT_DAY_VERSION) throw new TransitDayError('unsupported_version', 'Версия дневного транзита не поддерживается.', 400, null);
  const date = searchParams.get('date'), value = transitDateMilliseconds(date);
  const today = Date.parse(`${utcDate(now)}T00:00:00Z`);
  if (Math.abs(value - today) > 2 * DAY_MS) throw new TransitDayError('date_out_of_range', 'Доступны транзиты в пределах двух дней от сегодняшней даты UTC.', 422, null);
  return { date, versioned: version === TRANSIT_DAY_VERSION };
}

export function createTransitDayHandler({ get }, { now = () => new Date() } = {}) {
  return async function handle(req, res, url) {
    if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405, { Allow: 'GET, HEAD', 'Cache-Control': 'no-store' }); res.end(); return; }
    try {
      const { date, versioned } = validateTransitDayQuery(url.searchParams, now());
      const encoding = negotiateEncoding(req.headers['accept-encoding']);
      if (!encoding) throw new TransitDayError('encoding_not_acceptable', 'Нет поддерживаемого способа передачи дневного транзита.', 406, null);
      const packet = await get(date), body = packet.bytes[encoding], etag = packet.etags[encoding];
      const headers = { 'Content-Type': 'application/octet-stream', 'Content-Length': body.length,
        'Cache-Control': versioned ? 'public, max-age=31536000, immutable' : 'no-cache',
        Vary: 'Accept-Encoding', ETag: etag, 'X-Content-Type-Options': 'nosniff',
        ...(encoding === 'identity' ? {} : { 'Content-Encoding': encoding }) };
      const matched = String(req.headers['if-none-match'] || '').split(',').some(value => value.trim() === '*' || value.trim().replace(/^W\//, '') === etag);
      res.writeHead(matched ? 304 : 200, headers);
      res.end(matched || req.method === 'HEAD' ? undefined : body);
    } catch (error) {
      const known = error instanceof TransitDayError;
      res.writeHead(known ? error.status : 503, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
        ...(known && error.retryAfter === null ? {} : { 'Retry-After': String(known ? error.retryAfter : 5) }) });
      res.end(req.method === 'HEAD' ? undefined : JSON.stringify({ error: known ? error.code : 'transit_unavailable', message: known ? error.message : 'Не удалось подготовить дневной транзит. Повторите попытку.' }));
    }
  }
}
