import { createTransitDayHandler } from './transit-days.mjs';
import { createNatalDayHandler } from './natal-days.mjs';
import { createPublicFileHandler } from './public-files.mjs';
import { createLifetimeHandler } from './lifetime.mjs';
import { createLifetimeMoments } from '../services/lifetime.mjs';

const MAX_REQUEST_BYTES = 20000;
function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(data));
}

// Transport validation lives here; the catalogue owns city identity and the
// calculator owns process execution. Importing this module starts no server.
export function createRequestHandler({ root, cities, calculate, transitDays, chartDays, lifetime, now, publicFiles = createPublicFileHandler({ root }) }) {
  const transitDay = transitDays && createTransitDayHandler(transitDays, { now });
  const natalDay = chartDays && createNatalDayHandler(chartDays);
  const lifetimePoint = createLifetimeHandler(createLifetimeMoments({ archive: lifetime, calculate }));
  return async function handleRequest(req, res) {
    try {
      const url = new URL(req.url, 'http://localhost');
      // No cross-origin access to the API; no birth details in logs.
      if (req.headers.origin && new URL(req.headers.origin).host !== req.headers.host) {
        json(res, 403, { error: 'origin', message: 'Откройте сайт с адреса локального сервера.' }); return;
      }
      if (url.pathname === '/api/lifetime' || url.pathname === '/api/lifetime/meta') {
        await lifetimePoint(req, res, url); return;
      }
      if (url.pathname === '/api/transit/day') {
        if (!transitDays) { json(res, 503, { error: 'transit_unavailable', message: 'Дневной транзит недоступен.' }); return; }
        await transitDay(req, res, url); return;
      }
      if (url.pathname === '/api/chart/day') {
        if (!chartDays) { json(res, 503, { error: 'chart_day_unavailable', message: 'День рождения недоступен.' }); return; }
        await natalDay(req, res, cities); return;
      }
      if (url.pathname === '/api/cities' && req.method === 'GET') {
        json(res, 200, { cities: cities.search(url.searchParams.get('q') || '') }); return;
      }
      if (url.pathname === '/api/calculate' && req.method === 'POST') {
        if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) { json(res, 415, { error: 'content_type', message: 'Нужны данные JSON.' }); return; }
        const chunks = []; let size = 0;
        for await (const chunk of req) {
          size += chunk.length;
          if (size > MAX_REQUEST_BYTES) { json(res, 413, { error: 'too_large', message: 'Слишком большой запрос.' }); return; }
          chunks.push(chunk);
        }
        let input;
        try { input = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { json(res, 400, { error: 'invalid_json', message: 'Не удалось прочитать данные.' }); return; }
        if (!input || typeof input !== 'object' || Array.isArray(input)) { json(res, 400, { error: 'invalid_request', message: 'Некорректные данные.' }); return; }
        if (input.mode !== 'transit') {
          const city = cities.find(input.cityId, input.cityName);
          if (!city) { json(res, 422, { error: 'city_required', message: 'Выберите город из списка подсказок.' }); return; }
          input.city = city;
        }
        const result = await calculate(input);
        const status = !result.error ? 200 : ['engine_unavailable', 'busy'].includes(result.error) ? 503 : 422;
        json(res, status, result); return;
      }
      await publicFiles(req, res, url.pathname);
    } catch { if (!res.headersSent) json(res, 400, { error: 'invalid_request', message: 'Не удалось обработать запрос.' }); else res.end(); }
  };
}
