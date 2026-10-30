import test from 'node:test';
import assert from 'node:assert/strict';
import {attachChartLink} from '../src/views/chart-link.ts';
import {attachKnowledgeEntry} from '../src/views/knowledge-entry.ts';
import {attachKnowledge} from '../src/views/knowledge.ts';
import {attachChartSummary} from '../src/views/chart-summary-panel.ts';
import {attachAllCharts} from '../src/views/all-charts.ts';
import {createPanelState} from '../src/state/panels.ts';
import {dateDom} from './helpers/date-dom.ts';
import {libraryDom} from './helpers/library-dom.ts';
import {SVG_NS,svgDocument} from './helpers/svg-dom.ts';

function deferred<T>() {let resolve!:(value:T)=>void,reject!:(reason:Error)=>void;const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
const drain=async()=>{for(let i=0;i<8;i++)await Promise.resolve();};
const html=(node:unknown)=>node as HTMLElement;
const button=(node:unknown)=>{const element=node as HTMLButtonElement;if(!element.removeAttribute)element.removeAttribute=name=>element.setAttribute(name,'');return element;};

function knowledgeFixture(){
 const document=svgDocument(),events=dateDom(),surfaces:[object,ReturnType<typeof events.createElement>][]=[];
 function wire<T extends object>(node:T){const event=events.createElement('div');surfaces.push([node,event]);Object.assign(node,{addEventListener:event.addEventListener.bind(event),removeEventListener:event.removeEventListener.bind(event)});return node;}
 wire(document);
 const create=(tag:string)=>document.createElementNS(SVG_NS,tag);
 const page=wire(Object.assign(create('section'),{hidden:true}));
 const article=wire(create('article')),search=wire(Object.assign(create('input'),{value:'',id:'knowledgeSearch'})),toggle=wire(create('button'));
 search.setAttribute('type','search');toggle.setAttribute('data-workspace-search-toggle','');toggle.setAttribute('aria-controls','knowledgeSearch');
 const nodes={knowledgeIndex:create('nav'),knowledgeArticle:article,knowledgeSearch:search,knowledgeSection:Object.assign(create('select'),{value:''}),knowledgeCount:create('p')};
 for(const [id,node] of Object.entries(nodes)){node.setAttribute('id',id);page.append(node);}page.append(toggle);
 return {page,search,article,events,counts:()=>surfaces.reduce((sum,[,surface])=>sum+surface.listenerCount(),0),emit(target:object,type:string,event={}){surfaces.find(([node])=>node===target)?.[1].dispatch(type,{target,...event} as never);}};
}

test('thirty knowledge entry lifetimes dispose the loaded real page and its search bindings',async()=>{
 const h=knowledgeFixture(),entryButton=h.events.createElement('button');let changes=0,loads=0;
 const load=async()=>{loads++;return {attachKnowledge} as typeof import('../src/views/knowledge.ts');};
 let old:ReturnType<typeof attachKnowledgeEntry>|undefined;
 for(let i=0;i<30;i++){
  const view=attachKnowledgeEntry({button:button(entryButton),dialog:html(h.page),getSelection:()=>null,onSelect(){},onChange:()=>changes++,load});
  assert.equal(await view.show(),true);assert.equal(h.page.hidden,false);assert.equal(h.counts(),14);assert.equal(entryButton.listenerCount(),1);
  old?.hide();assert.equal(h.page.hidden,false,'the retired page must not hide its successor');
  await view.dispose();await view.dispose();assert.equal(h.counts(),0);assert.equal(entryButton.listenerCount(),0);
  assert.equal(h.page.hidden,true);assert.equal(await view.show(),false);assert.equal(view.restoreInputFocus(),false);old=view;
 }
 const before=changes;h.emit(h.search,'input');h.emit(h.page,'input',{target:h.search});assert.equal(changes,before);assert.equal(loads,30);
});

test('retired lazy imports neither attach a page nor clear a newer busy state or report a failure',async()=>{
 const doc=dateDom(),entryButton=doc.createElement('button');let loads=0;
 const stopped=attachKnowledgeEntry({button:button(entryButton),dialog:html(doc.createElement('section')),getSelection:()=>null,onSelect(){},load:async()=>{loads++;return {attachKnowledge} as typeof import('../src/views/knowledge.ts');}});
 const abandoned=stopped.show();await stopped.dispose();assert.equal(await abandoned,false);assert.equal(loads,0,'do not start a queued import after disposal');
 for(const failure of [false,true]){
  const doc=dateDom(),entryButton=doc.createElement('button'),dialog=doc.createElement('section');let attachments=0,errors=0;
  const oldLoad=deferred<typeof import('../src/views/knowledge.ts')>(),nextLoad=deferred<typeof import('../src/views/knowledge.ts')>();
  const module={attachKnowledge(){attachments++;return {show(){dialog.hidden=false;},hide(){dialog.hidden=true;},dispose(){dialog.hidden=true;},restoreInputFocus:()=>false};}} as unknown as typeof import('../src/views/knowledge.ts');
  const options={button:button(entryButton),dialog:html(dialog),getSelection:()=>null,onSelect(){},onError(){errors++;}};
  const old=attachKnowledgeEntry({...options,load:()=>oldLoad.promise});const opening=old.show();await drain();await old.dispose();
  const next=attachKnowledgeEntry({...options,load:()=>nextLoad.promise});const reopened=next.show();await drain();
  if(failure)oldLoad.reject(Error('late'));else oldLoad.resolve(module);
  assert.equal(await opening,false);assert.equal(entryButton.getAttribute('aria-busy'),'true');assert.equal(attachments,0);assert.equal(errors,0);
  nextLoad.resolve(module);assert.equal(await reopened,true);await next.dispose();assert.equal(attachments,1);
 }
});

test('retired clipboard consumers remove only their listeners and cannot close a newer shared notice',async()=>{
 const doc=dateDom(),root=doc.body,copy=doc.createElement('button');root.append(copy);let revision=0,active=0,writes=0;
 const notice={get revision(){return revision;},show(){const token=++revision;active=token;return {get active(){return active===token;},update(){},close(){if(active===token)active=0;}};},close(){active=0;},contains:()=>false};
 const late=deferred<void>();
 const options={button:button(copy),root:html(root),boundary:html(root),notice,writeText:()=>{writes++;return late.promise;}};
 const previous=attachChartLink(options);previous.update('https://example.test/chart/1');const clicked=copy.dispatch('click');
 await previous.dispose();const next=attachChartLink({...options,writeText:async()=>{writes++;}});next.update('https://example.test/chart/2');
 await copy.dispatch('click');const shown=active;assert.ok(shown);late.resolve();await clicked;assert.equal(active,shown);
 previous.update(null);await previous.dispose();assert.equal(copy.hidden,false);assert.equal(active,shown);await next.dispose();assert.equal(active,0);
 const owner=attachChartLink({...options,writeText:async()=>{}});owner.update('https://example.test/chart/3');await copy.dispatch('click');assert.ok(active);
 notice.show();const otherMessage=active;await owner.dispose();assert.equal(active,otherMessage,'disposing one handle preserves a message owned by another action');
 let neighbor=0;root.addEventListener('pointerdown',()=>neighbor++);
 for(let i=0;i<30;i++){const view=attachChartLink(options);assert.equal(root.listenerCount()+copy.listenerCount(),4);await view.dispose();assert.equal(root.listenerCount()+copy.listenerCount(),1);}
 root.dispatch('pointerdown',{target:root});assert.equal(neighbor,1);assert.equal(writes,2);
});

test('summary disposal unsubscribes without changing shared panel state or a successor projection',async()=>{
 const doc=dateDom(),panel=doc.createElement('aside'),summary=doc.createElement('section'),returns=doc.createElement('section'),switcher=doc.createElement('button'),backdrop=doc.createElement('div'),returnButton=doc.createElement('button');
 const classes=new Set<string>();Object.assign(panel,{classList:{toggle(name:string,on:boolean){if(on)classes.add(name);else classes.delete(name);return on;},contains:(name:string)=>classes.has(name)}});
 panel.append(summary,returns);summary.append(returnButton);const panels=createPanelState();let ownSubscriptions=0,neighbor=0,commands=0;
 const subscribe=panels.subscribe;panels.subscribe=listener=>{ownSubscriptions++;const remove=subscribe(listener);return ()=>{ownSubscriptions--;return remove();};};
 const removeNeighbor=subscribe(()=>neighbor++);
 const options={panels,panel:html(panel),summaryScreen:html(summary),returnsPanel:html(returns),switcher:button(switcher),backdrop:html(backdrop),returnsButton:button(returnButton),onReturns:()=>commands++};
 let old:ReturnType<typeof attachChartSummary>|undefined;
 for(let i=0;i<30;i++){
  const view=attachChartSummary(options);view.open();assert.equal(panels.right,true);assert.equal(ownSubscriptions,1);assert.equal(switcher.listenerCount()+backdrop.listenerCount()+returnButton.listenerCount(),3);
  old?.close();old?.setReturnsVisible(true);old?.layout();assert.equal(panels.right,true);assert.equal(view.screen,'summary');
  await view.dispose();await view.dispose();assert.equal(ownSubscriptions,0);assert.equal(switcher.listenerCount()+backdrop.listenerCount()+returnButton.listenerCount(),0);assert.equal(panels.right,true);
  assert.equal(view.opened,false);panels.setRight(false);old=view;
 }
 returnButton.dispatch('click');assert.equal(commands,0);assert.equal(neighbor,60);removeNeighbor();
});

function chartsFixture(observe:boolean){
 const dom=libraryDom(),events=dateDom(),dialog=events.createElement('section'),open=events.createElement('button'),search=events.createElement('input'),toggle=events.createElement('button'),scroll=events.createElement('div');
 dialog.hidden=true;search.id='allChartsSearch';toggle.setAttribute('aria-controls',search.id);
 dialog.querySelector=((selector:string)=>selector==='[data-workspace-search-toggle]'?toggle:selector==='#allChartsSearch'?search:null) as never;
 dialog.querySelectorAll=(()=>[search]) as never;
 Object.assign(dom.document,{defaultView:events.defaultView});const list=dom.chartList;
 Object.assign(list,{addEventListener:scroll.addEventListener.bind(scroll),removeEventListener:scroll.removeEventListener.bind(scroll)});
 list.replaceChildren=()=>{for(const row of [...dom.children])row.remove();};
 const jobs=new Map<number,()=>void>(),pendingPaints:(()=>void)[]=[],active=new Set<object>(),watched=new Set<Element>();let nextJob=0,intersection:IntersectionObserverCallback|undefined,changes=0;
 const records=Array.from({length:3},(_,i)=>({id:String(i),name:String(i),source:'calculated',personality:[1],design:[2]}));
 const options={button:button(open),dialog:html(dialog),list,getCharts:()=>records,document:dom.document,onChange:()=>changes++,
  createObserver:observe?(callback:IntersectionObserverCallback)=>{intersection=callback;return {observe:(row:Element)=>watched.add(row),unobserve:(row:Element)=>watched.delete(row),disconnect:()=>watched.clear()} as unknown as IntersectionObserver;}:null,
  preview(_canvas:unknown,_record:unknown,{onReady}:{onReady:(success:boolean)=>void}){const key={};active.add(key);pendingPaints.push(()=>onReady(true));return ()=>active.delete(key);},
  schedule(callback:()=>void){const id=++nextJob;jobs.set(id,callback);return id;},cancel:(id:number)=>{jobs.delete(id);}} as unknown as Parameters<typeof attachAllCharts>[0];
 return {dom,events,dialog,search,toggle,options,jobs,active,watched,pendingPaints,get changes(){return changes;},
  count:()=>open.listenerCount()+search.listenerCount()+toggle.listenerCount()+dialog.listenerCount()+scroll.listenerCount()+events.listenerCount()+events.defaultView.listenerCount(),
  tick(){const batch=[...jobs.values()];jobs.clear();for(const run of batch)run();},
  intersection:()=>intersection};
}

test('thirty chart-list lifetimes settle readiness and release previews, observers, scheduling and input bindings',async()=>{
 for(const observe of [false,true]){
  const h=chartsFixture(observe);let old:ReturnType<typeof attachAllCharts>|undefined;
  for(let i=0;i<30;i++){
   const view=attachAllCharts(h.options);view.show();assert.equal(h.dom.children.length,3);const ready=view.whenReady();h.tick();assert.ok(h.active.size>0);assert.equal(h.count(),13);
   const staleObserver=h.intersection(),staleRows=[...h.dom.children],staleJob=[...h.jobs.values()][0];
   old?.close();old?.setVisible(false);assert.equal(h.dialog.hidden,false);assert.equal(h.dom.children.length,3);
   await view.dispose();await view.dispose();assert.equal(h.count(),0);assert.equal(await ready,null);assert.equal(await view.whenReady(),null);
   assert.equal(h.count(),0);assert.equal(h.jobs.size,0);assert.equal(h.active.size,0);assert.equal(h.watched.size,0);assert.equal(h.dom.children.length,0);
   h.dialog.hidden=false;staleObserver?.(staleRows.map(target=>({target,isIntersecting:true})) as unknown as IntersectionObserverEntry[],{} as IntersectionObserver);staleJob?.();for(const callback of h.pendingPaints.splice(0))callback();
   view.show();view.update();assert.equal(h.dom.children.length,0);assert.equal(h.jobs.size,0);h.dialog.hidden=true;old=view;
  }
  const changes=h.changes;h.search.dispatch('input');h.events.defaultView.dispatch('resize');assert.equal(h.changes,changes);
 }
});
