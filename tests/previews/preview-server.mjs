import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const root = new URL('../../', import.meta.url);
const escape = value => String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));

function renderPage(config) {
  const data = JSON.stringify(config).replace(/</g, '\\u003c');
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(config.title)}</title>
  <link rel="stylesheet" href="/styles.css"><style>body{margin:0;background:white}#previewSurface{position:relative;width:100vw;height:100dvh;overflow:hidden;touch-action:none}#preview{position:absolute;inset:0;display:block;width:100%;height:100%;overflow:visible}nav{position:fixed;z-index:10;top:8px;left:12px;right:12px;display:flex;flex-wrap:wrap;align-items:center;gap:8px;font:12px system-ui}nav button{padding:6px;background:#eee;border-radius:4px}</style></head><body>
  <nav><span>Тестовые данные</span>${config.controls.map(control => `<button id="${escape(control.id)}">${escape(control.label)}</button>`).join('')}</nav>
  <div id="previewSurface"><svg id="preview" viewBox="${escape(config.viewBox)}" tabindex="0" aria-label="Синтетический бодиграф"><g id="viewport"></g></svg></div>
  <div id="activationPopover" class="activation-popover" role="tooltip" hidden></div>
  <script id="previewData" type="application/json">${data}</script>
  <script type="module">import { mountPreview } from '/preview-harness.js'; mountPreview(JSON.parse(document.getElementById('previewData').textContent));</script>
  </body></html>`;
}

// Only browser source modules and the preview assets are exposed. The application
// entry, API, saved charts, server, data, and other test files are never served.
export async function readPreviewResource(pathname, config) {
  if (pathname === '/') return { status: 200, type: 'text/html; charset=utf-8', body: renderPage(config) };
  const file = pathname === '/preview-harness.js' ? new URL('./preview-harness.js', import.meta.url)
    : pathname === '/styles.css' ? new URL('public/styles.css', root)
      : !['/src/app.js', '/src/startup.js'].includes(pathname) && /^\/src\/(?:[a-z0-9_-]+\/)*[a-z0-9_-]+\.js$/i.test(pathname) ? new URL(pathname.slice(1), root) : null;
  if (!file) return { status: 404, body: 'Not found' };
  try {
    return { status: 200, type: pathname.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8', body: await readFile(file, 'utf8') };
  } catch (error) {
    if (error.code === 'ENOENT') return { status: 404, body: 'Not found' };
    throw error;
  }
}

export function startPreviewIfMain(entryUrl, config) {
  if (!process.argv[1] || entryUrl !== pathToFileURL(process.argv[1]).href) return;
  createServer(async (request, response) => {
    if (!['GET', 'HEAD'].includes(request.method)) { response.writeHead(405, { Allow: 'GET, HEAD' }).end(); return; }
    try {
      const resource = await readPreviewResource(new URL(request.url, 'http://localhost').pathname, config);
      response.writeHead(resource.status, { 'Content-Type': resource.type || 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      response.end(request.method === 'HEAD' ? undefined : resource.body);
    } catch { response.writeHead(500).end('Preview unavailable'); }
  }).listen(4174, '127.0.0.1', () => process.stdout.write(`${config.title}: http://127.0.0.1:4174\n`));
}
