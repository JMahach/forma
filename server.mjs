import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 4173);
const host = process.env.HOST || '127.0.0.1';
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json; charset=utf-8' };
const allowed = new Set(['index.html', 'app.js', 'storage.js', 'gestures.js', 'graph-data.js', 'bodygraph.js', 'date-input.js', 'styles.css', 'favicon.svg']);
const normalize = text => String(text).normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/ё/g, 'е').trim();
const cities = JSON.parse(await fs.readFile(path.join(root, 'data/cities.json'), 'utf8'));
const cityIndex = new Map(cities.map(city => [String(city.id), city]));
const searchable = cities.map(city => ({ city, names: [...new Set([city.name, ...city.aliases].map(normalize))] }));
const publicCity = (city, label) => {
  const { id, country, region, timezone, latitude, longitude } = city;
  const name = label && city.aliases.includes(label) ? label : city.aliases[0] || city.name;
  return { id, name, country, region, timezone, latitude, longitude };
};
function searchCities(query) {
  const q = normalize(query).slice(0, 80);
  if (q.length < 2) return [];
  const exact = [], prefix = [], rest = [];
  for (const { city, names } of searchable) {
    if (names.some(name => name === q)) exact.push(city);
    else if (prefix.length < 12 && names.some(name => name.startsWith(q))) prefix.push(city);
    else if (rest.length < 12 && names.some(name => name.includes(q))) rest.push(city);
  }
  return [...exact, ...prefix, ...rest].slice(0, 12).map(city => {
    const alias = city.aliases.find(name => normalize(name) === q) || city.aliases.find(name => normalize(name).startsWith(q));
    return publicCity(city, alias);
  });
}
function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(data));
}
let runningCalculations = 0;
async function calculate(input) {
  if (runningCalculations >= 4) return { error: 'busy', message: 'Подождите завершения текущего расчёта и повторите попытку.' };
  runningCalculations += 1;
  try {
    return await new Promise(resolve => {
      const worker = spawn(path.join(root, '.venv/bin/python'), [path.join(root, 'calculator.py')], { cwd: root, stdio: ['pipe', 'pipe', 'ignore'] });
      let output = '', settled = false;
      const finish = value => { if (settled) return; settled = true; clearTimeout(timeout); resolve(value); };
      const unavailable = { error: 'engine_unavailable', message: 'Локальный движок расчёта недоступен. Проверьте установку зависимостей.' };
      const timeout = setTimeout(() => { worker.kill(); finish({ error: 'timeout', message: 'Расчёт занял слишком много времени. Попробуйте ещё раз.' }); }, 15000);
      worker.stdout.setEncoding('utf8');
      worker.stdout.on('data', chunk => { output += chunk; if (output.length > 100000) { worker.kill(); finish(unavailable); } });
      worker.on('error', () => finish(unavailable));
      worker.stdin.on('error', () => finish(unavailable));
      worker.on('close', code => {
        if (code !== 0) { finish(unavailable); return; }
        try { finish(JSON.parse(output)); } catch { finish(unavailable); }
      });
      worker.stdin.end(JSON.stringify(input));
    });
  } finally { runningCalculations -= 1; }
}
http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    // No cross-origin access to the local API; no birth details in logs.
    if (req.headers.origin && new URL(req.headers.origin).host !== req.headers.host) {
      json(res, 403, { error: 'origin', message: 'Откройте сайт с адреса локального сервера.' }); return;
    }
    if (url.pathname === '/api/cities' && req.method === 'GET') {
      json(res, 200, { cities: searchCities(url.searchParams.get('q') || '') }); return;
    }
    if (url.pathname === '/api/calculate' && req.method === 'POST') {
      if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) { json(res, 415, { error: 'content_type', message: 'Нужны данные JSON.' }); return; }
      const chunks = []; let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 20000) { json(res, 413, { error: 'too_large', message: 'Слишком большой запрос.' }); return; }
        chunks.push(chunk);
      }
      let input;
      try { input = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { json(res, 400, { error: 'invalid_json', message: 'Не удалось прочитать данные.' }); return; }
      if (!input || typeof input !== 'object' || Array.isArray(input)) { json(res, 400, { error: 'invalid_request', message: 'Некорректные данные.' }); return; }
      if (input.mode !== 'transit') {
        const city = cityIndex.get(String(input.cityId));
        if (!city) { json(res, 422, { error: 'city_required', message: 'Выберите город из списка подсказок.' }); return; }
        input.city = publicCity(city, input.cityName);
      }
      const result = await calculate(input);
      json(res, result.error ? result.error === 'engine_unavailable' || result.error === 'busy' ? 503 : 422 : 200, result); return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, { Allow: 'GET, HEAD' }); res.end(); return; }
    const filename = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
    if (!allowed.has(filename)) { res.writeHead(404); res.end('Not found'); return; }
    const data = await fs.readFile(path.join(root, filename));
    res.writeHead(200, { 'Content-Type': types[path.extname(filename)] || 'text/plain', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
    res.end(req.method === 'HEAD' ? undefined : data);
  } catch { if (!res.headersSent) json(res, 400, { error: 'invalid_request', message: 'Не удалось обработать запрос.' }); else res.end(); }
}).listen(port, host, () => console.log(`Линия: http://${host}:${port}`));
