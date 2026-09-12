// Deliberately synthetic chart, isolated from the user's saved cards.
// Run: node tests/previews/line-fixing-preview.mjs; open http://localhost:4174.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';

const allowed = new Set(['styles.css', 'src/bodygraph/bodygraph.js', 'src/bodygraph/graph-data.js', 'src/selection/selection-state.js', 'src/bodygraph/integration-geometry.js', 'src/activations/activations.js', 'src/activations/line-fixing.js', 'src/activations/line-fixing-data.js', 'src/activations/activation-details.js', 'src/activations/activation-popover.js', 'src/activations/variables.js', 'src/activations/variable-arrows.js', 'src/selection/hover-preview.js', 'src/bodygraph/gestures.js']);
createServer(async (request, response) => {
  const file = new URL(request.url, 'http://localhost').pathname.slice(1);
  response.setHeader('Cache-Control', 'no-store');
  if (allowed.has(file)) {
    response.setHeader('Content-Type', file.endsWith('.css') ? 'text/css' : 'text/javascript');
    response.end(await readFile(new URL(file === 'styles.css' ? '../../public/styles.css' : `../../${file}`, import.meta.url))); return;
  }
  if (file) { response.writeHead(404).end(); return; }
  const app = await readFile(new URL('../../src/app.js', import.meta.url), 'utf8');
  const handlers = ['renderGraph', 'choose', 'clearSelection'].map(name => {
    const handler = app.match(new RegExp(`^function ${name}\\([^)]*\\) \\{[\\s\\S]*?^\\}`, 'm'))?.[0];
    if (!handler) throw new Error(`Missing application handler: ${name}`);
    return handler;
  }).join('\n');
  response.setHeader('Content-Type', 'text/html; charset=utf-8');
  response.end(`<!doctype html><html lang="ru"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Фиксации — тестовые данные</title>
  <link rel="stylesheet" href="/styles.css"><style>body{margin:0;background:white}#preview{display:block;width:100vw;height:100dvh}nav{position:fixed;z-index:10;top:8px;left:12px;right:12px;display:flex;gap:8px;font:12px system-ui}nav button{padding:6px;background:#eee;border-radius:4px}</style>
  <nav><span>Тестовые данные</span><button id="home">Домой</button><button id="leave">Увести мышь</button></nav><svg id="preview" viewBox="-52 28 744 740"><g id="viewport"></g></svg>
  <div id="activationPopover" class="activation-popover" role="tooltip" hidden></div>
  <script type="module">
  import { renderBodygraph } from '/src/bodygraph/bodygraph.js';
  import { createSelectionState } from '/src/selection/selection-state.js';
  import { PLANETS } from '/src/activations/activations.js';
  import { attachActivationPopover } from '/src/activations/activation-popover.js';
  import { attachHoverPreview } from '/src/selection/hover-preview.js';
  import { attachGestures } from '/src/bodygraph/gestures.js';
  const wheel=[41,19,13,49,30,55,37,63,22,36,25,17,21,51,42,3,27,24,2,23,8,20,16,35,45,12,15,52,39,53,62,56,31,33,7,4,29,59,40,64,47,6,46,18,48,57,32,50,28,44,1,43,14,34,9,5,26,11,10,58,38,54,61,60];
  const overrides={design:{sun:[55,2],earth:[16,3],moon:[23,4],venus:[39,1],mars:[48,1],pluto:[43,2]},personality:{sun:[55,2],earth:[16,4],moon:[23,4],venus:[39,1],mars:[48,1],pluto:[43,2]}};
  const entries=source=>PLANETS.map(([planet],i)=>{
    const [gate,line]=overrides[source][planet]||[41,i%6+1];
    return {planet,gate,line,longitude:(302+wheel.indexOf(gate)*5.625+(line-1)*.9375+.123)%360};
  });
  const activations={design:entries('design'),personality:entries('personality')};
  const data={id:'synthetic',source:'birth',activations,design:activations.design.map(a=>a.gate),personality:activations.personality.map(a=>a.gate)};
  const savedCharts=[data],selectedChartId=data.id;
  const chart=()=>data,$=id=>document.getElementById(id==='bodygraph'?'preview':id);
  const selectionState=createSelectionState();
  let hoverPreview=null;
  const svg=$('bodygraph'),activationPopover=attachActivationPopover($('activationPopover'),svg);
  const gestures=attachGestures(svg,$('viewport'),{onSelect:choose,onBackgroundTap:clearSelection,onChange:()=>{hoverPreview?.clear();activationPopover.reposition();}});
  hoverPreview=attachHoverPreview(svg,{onPreview:()=>renderGraph()});
  ${handlers}
  renderGraph();
  $('home').addEventListener('click',()=>gestures.reset());
  $('leave').addEventListener('click',()=>svg.dispatchEvent(new PointerEvent('pointerleave',{pointerType:'mouse'})));
  </script></html>`);
}).listen(4174, '127.0.0.1', () => process.stdout.write('Line fixing preview ready\n'));
