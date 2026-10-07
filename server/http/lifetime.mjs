import { LifetimeError } from '../services/lifetime.mjs';
import { LIFETIME_EXACT_VERSION } from '../../shared/lifetime-format.js';

const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
function json(res, status, value, immutable = false) {
  const body = JSON.stringify(value);
  res.writeHead(status, { ...headers, ...(immutable ? { 'Cache-Control': 'public, max-age=31536000, immutable' } : {}),
    'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

export function createLifetimeHandler(service) {
  return async function handle(req, res, suppliedUrl) {
    if (req.method !== 'GET') { res.writeHead(405, { ...headers, Allow: 'GET' }); res.end(); return; }
    try {
      if (!service) throw new LifetimeError('lifetime_unavailable', 'Данные летописи недоступны.');
      const url = suppliedUrl || new URL(req.url, 'http://localhost');
      if (url.pathname === '/api/lifetime/meta') {
        if (url.searchParams.size) throw new LifetimeError('invalid_request', 'Некорректный запрос шкалы.', 400);
        json(res, 200, service.metadata); return;
      }
      const exact = url.pathname === '/api/lifetime/moment';
      if (!exact && url.pathname !== '/api/lifetime') throw new LifetimeError('not_found', 'Страница не найдена.', 404);
      const values = url.searchParams.getAll(exact ? 'utc' : 'index');
      const versions = url.searchParams.getAll('v');
      if (values.length !== 1 || versions.length > 1 || url.searchParams.size !== 1 + versions.length
          || !exact && !/^(?:0|[1-9]\d{0,15})$/.test(values[0])) {
        throw new LifetimeError(exact ? 'invalid_utc' : 'invalid_index', 'Выберите момент в пределах шкалы.', 400);
      }
      if (versions.length && (!/^[a-f0-9]{64}$/.test(versions[0]) || versions[0] !== service.metadata?.cacheVersion)) {
        throw new LifetimeError('unsupported_version', 'Данные шкалы обновились. Обновите страницу.', 400);
      }
      const value = exact ? { version: LIFETIME_EXACT_VERSION, ...await service.getUtcMoment(values[0]) }
        : await service.getMoment(Number(values[0]));
      json(res, 200, value, versions.length === 1);
    } catch (error) {
      const known = error instanceof LifetimeError;
      json(res, known ? error.status : 503, { error: known ? error.code : 'lifetime_unavailable',
        message: known ? error.message : 'Данные летописи недоступны.' });
    }
  };
}
