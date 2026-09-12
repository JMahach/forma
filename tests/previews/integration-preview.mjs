// Local, synthetic visual fixtures. Does not load or change saved user charts.
import { createServer } from 'node:http';
import { stat } from 'node:fs/promises';
const fixtures = {
  empty: { personality: [], design: [] },
  black10: { personality: [10], design: [] },
  black34: { personality: [34], design: [] },
  black20: { personality: [20], design: [] },
  black57: { personality: [57], design: [] },
  red: { personality: [], design: [10, 20, 34, 57] },
  dual: { personality: [10, 20, 34, 57], design: [10, 20, 34, 57] },
};
createServer(async (request, response) => {
  const params = new URL(request.url, 'http://127.0.0.1').searchParams;
  const fixture = Object.hasOwn(fixtures, params.get('fixture')) ? params.get('fixture') : 'black34';
  const source = new URL('../../src/bodygraph/bodygraph.js', import.meta.url);
  const version = (await stat(source)).mtimeMs;
  const { renderBodygraph } = await import(`${source.href}?preview=${version}`);
  const lower = params.get('pair') === 'lower';
  const gates = lower ? [34, 57] : [10, 20];
  const bounds = lower ? '125 462 175 115' : '135 350 170 115';
  const cards = gates.map(id => `<section><h2>Ворота ${id}</h2><svg viewBox="${bounds}" xmlns="http://www.w3.org/2000/svg">${renderBodygraph(fixtures[fixture], { type: 'gate', id }, { interactive: false, idPrefix: `preview-${id}` })}</svg></section>`).join('');
  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(`<!doctype html><meta name="viewport" content="width=device-width"><title>Проверка обводки интеграции</title><style>body{margin:0;padding:16px;font:14px system-ui;background:#fff;color:#333}nav{display:flex;gap:16px;flex-wrap:wrap;margin-bottom:8px}a{color:#555}main{display:grid;grid-template-columns:1fr 1fr;gap:24px}section{min-width:0}h2{font-size:15px;font-weight:500}svg{width:100%;height:calc(100vh - 110px)}</style><nav>${Object.keys(fixtures).map(key=>`<a href="?fixture=${key}&pair=${lower ? 'lower' : 'upper'}">${key}</a>`).join('')}<a href="?fixture=${fixture}&pair=upper">10 / 20</a><a href="?fixture=${fixture}&pair=lower">34 / 57</a></nav><main>${cards}</main>`);
}).listen(4174, '127.0.0.1', () => process.stdout.write('Integration preview ready\n'));
