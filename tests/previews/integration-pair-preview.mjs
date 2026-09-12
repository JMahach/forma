// Synthetic pair/channel comparison. Never reads or writes saved charts.
import { createServer } from 'node:http';
import { renderBodygraph } from '../../src/bodygraph/bodygraph.js';

const pairs = [[10,34], [20,34], [10,57], [20,57], [10,20], [34,57]];
createServer((request, response) => {
  const params = new URL(request.url, 'http://localhost').searchParams;
  const pair = pairs.find(gates => gates.join('-') === params.get('pair')) || pairs[0];
  const colors = ['white','black','red','dual','only20'];
  const kind = colors.includes(params.get('color')) ? params.get('color') : 'dual';
  const chart = {personality: kind === 'only20' ? [20] : ['black','dual'].includes(kind) ? [10,20,34,57] : [], design: ['red','dual'].includes(kind) ? [10,20,34,57] : []};
  const gate = id => ({type:'gate',id});
  const cases = [
    ['Отдельные ворота вместе', {selections:pair.map(gate)}],
    ['Выбран целый канал', {selections:[{type:'channel',id:pair.join('-')}]}],
    ['Первые ворота после снятия вторых', {selections:[gate(pair[0])]}]
  ];
  const cards = cases.map(([title,options],index)=>`<section><h2>${title}</h2><svg viewBox="118 330 210 235" xmlns="http://www.w3.org/2000/svg">${renderBodygraph(chart,null,{...options,interactive:false,idPrefix:'pair-'+index})}</svg></section>`).join('');
  response.writeHead(200, {'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'});
  response.end(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Соединение интеграции — тестовые данные</title><style>body{margin:16px;background:white;color:#333;font:14px system-ui}nav{display:flex;gap:12px;margin-bottom:12px;flex-wrap:wrap}a{color:#555}main{display:grid;grid-template-columns:repeat(3,1fr);gap:20px}section{min-width:0}h2{font-size:13px;font-weight:500}svg{width:100%;height:calc(100vh - 140px)}</style><nav>Тестовые данные ${pairs.map(gates=>`<a href="?pair=${gates.join('-')}&color=${kind}">${gates.join('–')}</a>`).join('')}</nav><nav>${colors.map(color=>`<a href="?pair=${pair.join('-')}&color=${color}">${color}</a>`).join('')}</nav><main>${cards}</main>`);
}).listen(4175,'127.0.0.1',()=>process.stdout.write('Integration pair preview ready\n'));
