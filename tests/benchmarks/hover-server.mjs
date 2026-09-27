// Isolated local experiment. No API, saved charts or production files modified.
// Run: node tests/benchmarks/hover-server.mjs
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { readPreviewResource } from '../previews/preview-server.mjs';
import { MANDALA_FRAME } from '../../src/scene/geometry/frames.js';

const { x, y, width, height } = MANDALA_FRAME.bounds;
const wheelViewBox = `${x} ${y} ${width} ${height}`;

const page = `<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Мандала — замер отрисовки</title><link rel="stylesheet" href="/styles.css">
<style>
body{overflow:auto;font:14px system-ui;background:#fff}header{padding:12px;display:flex;gap:12px;align-items:center;flex-wrap:wrap}button{border:1px solid #ddd;padding:10px;border-radius:6px}
#stage{height:620px;position:relative}section{position:absolute;inset:0}section[hidden]{display:none}svg{width:100%;height:570px;display:block}
pre{white-space:pre-wrap;padding:12px;font:12px monospace}#status{min-width:250px}
</style><header><strong>Синтетическая карта · без сервера расчёта</strong><button id="verify">Проверить совпадение</button><button id="measure">Сравнить нагрузку</button><span id="status">Готово к проверке</span></header>
<div id="stage"><section id="baseline"><svg viewBox="${wheelViewBox}"><g class="viewport"></g></svg></section><section id="partial" hidden><svg viewBox="${wheelViewBox}"><g class="viewport"></g></svg></section></div>
<pre id="results" aria-live="polite">Замеры ещё не выполнены.</pre><script type="module" src="/benchmark.js"></script></html>`;

createServer(async (req, res) => {
  if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405).end(); return; }
  try {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    const resource = pathname === '/' ? { status: 200, type: 'text/html; charset=utf-8', body: page }
      : pathname === '/benchmark.js' ? { status: 200, type: 'text/javascript; charset=utf-8', body: await readFile(new URL('./hover-benchmark.js', import.meta.url), 'utf8') }
        : await readPreviewResource(pathname, {});
    res.writeHead(resource.status, { 'Content-Type': resource.type || 'text/plain', 'Cache-Control': 'no-store' });
    res.end(req.method === 'HEAD' ? undefined : resource.body);
  } catch { res.writeHead(500).end('Benchmark unavailable'); }
}).listen(4185, '127.0.0.1', () => console.log('Hover benchmark: http://127.0.0.1:4185'));
