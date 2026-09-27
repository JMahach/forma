import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { readPreviewResource } from '../previews/preview-server.mjs';

function page(kind) {
  const thumbnails = kind === 'thumbnails';
  const title = thumbnails ? 'Миниатюры: сравнение пикселей' : 'Контроллер: сохранение фокуса';
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>
  body{margin:20px;background:#f6f5f1;color:#292824;font:14px system-ui}h1{font-size:20px}button{padding:8px 14px;border:1px solid #bbb8ad;border-radius:8px;background:white;color:inherit}button:disabled{opacity:.5}nav{display:flex;gap:16px;margin-bottom:20px}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:white;border:1px solid #dfdcd4;border-radius:10px;padding:12px}#status{margin-left:12px}#examples{display:flex;flex-wrap:wrap;gap:16px}figure{margin:0;padding:12px;background:white;border:1px solid #dfdcd4;border-radius:8px}figure img,figure canvas{width:88px;height:136px;image-rendering:pixelated;border:1px solid #ddd;margin:4px}figcaption{max-width:400px}#chart{display:block;width:min(850px,100%);height:640px;background:white;border:1px solid #dfdcd4;border-radius:10px;margin-top:16px}
  </style></head><body><nav><a href="/thumbnails">Миниатюры</a><a href="/focus">Фокус</a></nav><h1>${title}</h1><p>${thumbnails
    ? 'Синтетические карты. Три изображения 44 × 68: опубликованный renderChartThumbnail, новый профиль миниатюры, новый renderChartThumbnail. Сравниваются все RGBA-байты без допуска.'
    : 'Реальный createGraphController и браузерный document.activeElement. Проверяются все 64 ворот при открытии, закрытии и промежуточной видимости мандалы.'}</p>
  <button id="verify">Проверить</button><button id="stop" disabled>Остановить</button><span id="status" role="status">Готово</span>
  ${thumbnails ? '<div id="examples"></div>' : '<svg id="chart" xmlns="http://www.w3.org/2000/svg" viewBox="-220 -100 1080 1020" aria-label="Синтетическая карта для проверки фокуса"><g id="viewport"></g></svg>'}
  <pre id="report" aria-live="polite">Результатов пока нет.</pre><script type="module" src="/${thumbnails ? 'thumbnail-pixels' : 'controller-focus'}.js"></script></body></html>`;
}

export async function regressionResource(pathname) {
  const baselineRoot = process.env.FORMA_BASELINE_ROOT;
  if (baselineRoot && pathname !== '/baseline/src/app.js' && /^\/baseline\/src\/(?:[a-z0-9_-]+\/)*[a-z0-9_-]+\.js$/i.test(pathname)) {
    try { return { status: 200, type: 'text/javascript; charset=utf-8', body: await readFile(path.join(baselineRoot, pathname.slice('/baseline/'.length)), 'utf8') }; }
    catch (error) { if (error.code === 'ENOENT') return { status: 404, body: 'Not found' }; throw error; }
  }
  if (pathname === '/' || pathname === '/thumbnails') return { status: 200, type: 'text/html; charset=utf-8', body: page('thumbnails') };
  if (pathname === '/focus') return { status: 200, type: 'text/html; charset=utf-8', body: page('focus') };
  const asset = pathname === '/thumbnail-pixels.js' || pathname === '/controller-focus.js'
    ? new URL(`.${pathname}`, import.meta.url)
    : pathname === '/fixtures/demo-chart.js' ? new URL('../fixtures/demo-chart.js', import.meta.url) : null;
  if (asset) return { status: 200, type: 'text/javascript; charset=utf-8', body: await readFile(asset, 'utf8') };
  return readPreviewResource(pathname, {});
}

export function startRegressionServer({ port = Number(process.env.PORT || 4187), host = '127.0.0.1' } = {}) {
  return createServer(async (request, response) => {
    if (!['GET', 'HEAD'].includes(request.method)) { response.writeHead(405, { Allow: 'GET, HEAD' }).end(); return; }
    try {
      const resource = await regressionResource(new URL(request.url, 'http://localhost').pathname);
      response.writeHead(resource.status, { 'Content-Type': resource.type || 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      response.end(request.method === 'HEAD' ? undefined : resource.body);
    } catch { response.writeHead(500).end('Regression preview unavailable'); }
  }).listen(port, host, () => process.stdout.write(`Browser regressions: http://${host}:${port}/thumbnails and /focus\n`));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) startRegressionServer();
