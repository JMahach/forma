// Synthetic visual fixture; never loads or writes the user's saved charts.
// Run with node tests/previews/activation-preview.mjs, then open localhost:4174.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';

const allowed = new Set(['styles.css', 'src/bodygraph/bodygraph.js', 'src/bodygraph/graph-data.js', 'src/selection/selection-state.js', 'src/bodygraph/integration-geometry.js', 'src/activations/activations.js', 'src/activations/line-fixing.js', 'src/activations/line-fixing-data.js', 'src/activations/activation-details.js', 'src/activations/activation-popover.js', 'src/activations/variables.js', 'src/activations/variable-arrows.js', 'src/selection/hover-preview.js', 'src/bodygraph/gestures.js']);
createServer(async (request, response) => {
  const path = new URL(request.url, 'http://localhost').pathname.slice(1);
  response.setHeader('Cache-Control', 'no-store');
  if (allowed.has(path)) {
    response.setHeader('Content-Type', path.endsWith('.css') ? 'text/css' : 'text/javascript');
    response.end(await readFile(new URL(path === 'styles.css' ? '../../public/styles.css' : `../../${path}`, import.meta.url)));
    return;
  }
  if (path) { response.writeHead(404).end(); return; }
  const app = await readFile(new URL('../../src/app.js', import.meta.url), 'utf8');
  const handlers = ['renderGraph', 'choose', 'clearSelection'].map(name => {
    const handler = app.match(new RegExp(`^function ${name}\\([^)]*\\) \\{[\\s\\S]*?^\\}`, 'm'))?.[0];
    if (!handler) throw new Error(`Missing application handler: ${name}`);
    return handler;
  }).join('\n');
  response.setHeader('Content-Type', 'text/html; charset=utf-8');
  response.end(`<!doctype html><html lang="ru"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Проверка активаций — тестовые данные</title>
  <link rel="stylesheet" href="/styles.css"><style>body{margin:0;background:white}#preview{display:block;width:100vw;height:100dvh}nav{position:fixed;z-index:10;top:8px;left:12px;right:12px;display:flex;flex-wrap:wrap;align-items:center;gap:8px;font:12px system-ui}nav button{padding:6px;background:#eee;border-radius:4px}</style>
  <nav><span>Тестовые данные</span><button id="hover1">Навести на 1</button><button id="hover20">Навести на 20</button><button id="hover29">Навести на 29</button><button id="hoverNumber">Навести на 41</button><button id="hoverCenter">Навести на Горловой</button><button id="pinThroat">Выбрать / снять Горловой</button><button id="leave">Увести мышь</button></nav><svg id="preview" viewBox="-360 0 1300 810"><g id="viewport"></g></svg>
  <div id="activationPopover" class="activation-popover" role="tooltip" hidden></div>
  <script type="module">
  import { renderBodygraph } from '/src/bodygraph/bodygraph.js';
  import { createSelectionState } from '/src/selection/selection-state.js';
  import { PLANETS } from '/src/activations/activations.js';
  import { attachActivationPopover } from '/src/activations/activation-popover.js';
  import { attachHoverPreview } from '/src/selection/hover-preview.js';
  import { attachGestures } from '/src/bodygraph/gestures.js';
  // Gate starts follow calculator.py's wheel; each longitude stays inside its stated line.
  const gateStart = {1:223.25,20:60.125,29:144.5,41:302};
  const fixtureGates = [41,20,1,29,20,41,1,29,20,41,1,29,20];
  const entry = (planet, index) => {
    const gate = fixtureGates[index % fixtureGates.length], line = index % 6 + 1;
    return {planet, gate, line, longitude:gateStart[gate]+(line-1)*.9375+.2345};
  };
  const data = {id:'synthetic',personality:[1,20,29,41],design:[1,20,29,41],activations:{design:PLANETS.map(([p],i)=>entry(p,i)),personality:PLANETS.map(([p],i)=>entry(p,i))}};
  const savedCharts=[data], selectedChartId=data.id, chart=()=>data, $=id=>document.getElementById(id==='bodygraph'?'preview':id);
  const selectionState=createSelectionState();
  let hoverPreview=null;
  const svg=document.querySelector('#preview'), panel=document.querySelector('#activationPopover');
  const activationPopover=attachActivationPopover(panel,svg);
  const gestures=attachGestures(svg,$('viewport'),{
    onSelect:choose,
    onBackgroundTap:clearSelection,
    onChange:()=>{hoverPreview?.clear();activationPopover.reposition();}
  });
  hoverPreview=attachHoverPreview(svg,{onPreview:()=>renderGraph()});
  ${handlers}
  renderGraph();
  function preview(selector){svg.querySelector(selector).dispatchEvent(new PointerEvent('pointermove',{bubbles:true,pointerType:'mouse',buttons:0}));}
  $('hover1').addEventListener('click',()=>preview('[data-activation="design-moon"]'));
  $('hover20').addEventListener('click',()=>preview('[data-activation="design-earth"]'));
  $('hover29').addEventListener('click',()=>preview('[data-activation="design-north_node"]'));
  $('hoverNumber').addEventListener('click',()=>preview('[data-activation="design-sun"]'));
  $('hoverCenter').addEventListener('click',()=>preview('[data-type="center"][data-id="throat"]'));
  $('pinThroat').addEventListener('click',()=>choose({type:'center',id:'throat'}));
  $('leave').addEventListener('click',()=>svg.dispatchEvent(new PointerEvent('pointerleave',{pointerType:'mouse'})));
  </script></html>`);
}).listen(4174, '127.0.0.1', () => process.stdout.write('Activation preview ready\n'));
