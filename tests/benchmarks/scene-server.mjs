import { createServer } from 'node:http';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { readPreviewResource } from '../previews/preview-server.mjs';

const page = `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Форма: проверка постоянной сцены</title>
<link rel="stylesheet" href="/styles.css"><style>
html,body{height:auto;overflow:auto}body{margin:0;padding:16px;background:#f6f5f1;color:#292824;font:14px system-ui}header{display:flex;gap:10px;align-items:center;flex-wrap:wrap}h1{font-size:18px;margin:0 16px 0 0}button{padding:8px 14px;border:1px solid #bbb8ad;border-radius:8px;background:white;color:inherit}button:disabled{opacity:.5}.scenes{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:12px}.pane{background:white;border:1px solid #dfdcd4;border-radius:10px;overflow:hidden}.pane h2{font-size:13px;margin:10px}svg{display:block;width:100%;height:600px}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:white;border:1px solid #dfdcd4;border-radius:10px;padding:12px}p{max-width:960px;line-height:1.5}
</style></head><body><header><h1>Постоянная SVG-сцена</h1><button id="verify">Проверить</button><button id="compare">Сравнить</button><button id="stop" disabled>Остановить</button><label id="baseline-control" hidden><input type="checkbox" id="use-baseline"> Проверять также прежний renderer</label><span id="status" role="status">Готово</span></header>
<p>Только синтетические данные. Слева — полная строковая отрисовка, справа — обновление существующих узлов. Проверка сравнивает всю SVG-сцену и сохранение интерактивных элементов. Замер: 240 последовательных минут × 2 прогона, все промежуточные обновления выполняются.</p>
<div class="scenes"><section class="pane"><h2>Полная перерисовка</h2><svg id="reference" viewBox="-220 -100 1080 1020" aria-label="Эталонная синтетическая карта"><g id="reference-root"></g></svg></section><section class="pane"><h2>Постоянная сцена</h2><svg id="persistent" viewBox="-220 -100 1080 1020" aria-label="Синтетическая карта постоянной сцены"><g id="persistent-root"></g></svg></section></div>
<pre id="report" aria-live="polite">Результатов пока нет.</pre><script type="module" src="/scene-benchmark.js"></script></body></html>`;

export async function sceneResource(pathname) {
  const baselineRoot = process.env.FORMA_BASELINE_ROOT;
  if (pathname === '/benchmark-config.json') return { status: 200, type: 'application/json; charset=utf-8', body: JSON.stringify({ baselineAvailable: Boolean(baselineRoot) }) };
  if (baselineRoot && pathname !== '/baseline/src/app.js' && /^\/baseline\/src\/(?:[a-z0-9_-]+\/)*[a-z0-9_-]+\.js$/i.test(pathname)) {
    try { return { status: 200, type: 'text/javascript; charset=utf-8', body: await readFile(path.join(baselineRoot, pathname.slice('/baseline/'.length)), 'utf8') }; }
    catch (error) { if (error.code === 'ENOENT') return { status: 404, body: 'Not found' }; throw error; }
  }

  if (pathname === '/') return { status: 200, type: 'text/html; charset=utf-8', body: page };
  if (pathname === '/scene-benchmark.js') return { status: 200, type: 'text/javascript; charset=utf-8', body: await readFile(new URL('./scene-benchmark.js', import.meta.url), 'utf8') };
  // Reuse the isolated preview source boundary. No API, library, application
  // entry, server, fixtures, filesystem browsing or saved user data is exposed.
  return readPreviewResource(pathname, {});
}

export function startSceneBenchmark({ port = Number(process.env.PORT || 4186), host = '127.0.0.1' } = {}) {
  return createServer(async (request, response) => {
    if (!['GET', 'HEAD'].includes(request.method)) { response.writeHead(405, { Allow: 'GET, HEAD' }).end(); return; }
    try {
      const resource = await sceneResource(new URL(request.url, 'http://localhost').pathname);
      response.writeHead(resource.status, { 'Content-Type': resource.type || 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      response.end(request.method === 'HEAD' ? undefined : resource.body);
    } catch { response.writeHead(500).end('Scene benchmark unavailable'); }
  }).listen(port, host, () => process.stdout.write(`Scene benchmark: http://${host}:${port}\n`));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) startSceneBenchmark();
