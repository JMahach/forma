import { LifetimeError } from '../services/lifetime.mjs';

const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
function json(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, { ...headers, 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

export function createLifetimeHandler(service) {
  return async function handle(req, res, suppliedUrl) {
    if (req.method !== 'GET') { res.writeHead(405, { ...headers, Allow: 'GET' }); res.end(); return; }
    try {
      if (!service) throw new LifetimeError('lifetime_unavailable', 'Данные шкалы лет недоступны.');
      const url = suppliedUrl || new URL(req.url, 'http://localhost');
      if (url.pathname === '/api/lifetime/meta') {
        if (url.searchParams.size) throw new LifetimeError('invalid_request', 'Некорректный запрос шкалы.', 400);
        json(res, 200, service.metadata); return;
      }
      if (url.pathname !== '/api/lifetime') throw new LifetimeError('not_found', 'Страница не найдена.', 404);
      const indices = url.searchParams.getAll('index');
      if (indices.length !== 1 || url.searchParams.size !== 1 || !/^(?:0|[1-9]\d{0,15})$/.test(indices[0])) {
        throw new LifetimeError('invalid_index', 'Выберите момент в пределах шкалы.', 400);
      }
      json(res, 200, await service.getMoment(Number(indices[0])));
    } catch (error) {
      const known = error instanceof LifetimeError;
      json(res, known ? error.status : 503, { error: known ? error.code : 'lifetime_unavailable',
        message: known ? error.message : 'Данные шкалы лет недоступны.' });
    }
  };
}
