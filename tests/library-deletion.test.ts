import test from 'node:test';
import assert from 'node:assert/strict';
import {UI_MESSAGES} from '../src/ui/messages.ts';
import {attachChartLibrary} from '../src/views/library.ts';

function harness() {
  const nodes=new Map<string,any>(), handlers=new Map<string,(e?:any)=>any>();
  let mode:'online'|'offline'='online', allowed=true, changed=()=>{}, selected='a', localWrites=0, checks=false;
  const selections:string[]=[], requests:{id:string;signal:AbortSignal;resolve:(value:any)=>void}[]=[];
  let queries=0, sourceReads=0;
  const actions:{edit:any[];delete:any[]}={edit:[],delete:[]};
  const records=['a','b'].map(id=>({id,name:id,source:'calculated',personality:[],design:[]}));
  for(const record of records)Object.defineProperty(record,'source',{get(){sourceReads++;return 'calculated';}});
  const document:any={getElementById:node,createElement:()=>node('generated-'+nodes.size),querySelectorAll:(selector:string)=>{queries++;return selector.includes('=\"edit\"')?actions.edit:selector.includes('=\"delete\"')?actions.delete:[];},querySelector:()=>null,
    addEventListener(type:string,fn:any){handlers.set('document:'+type,fn);}};
  function node(id:string):any {
    if(nodes.has(id))return nodes.get(id);
    let own='',children:any[]=[];const attrs=new Map();
    const value:any={id,ownerDocument:document,open:false,hidden:true,disabled:false,className:'',dataset:{},
      get textContent(){return own+children.map(n=>n.textContent).join('');},set textContent(v){own=v;children=[];},
      replaceChildren(...items:any[]){own='';children=items;},append(item:any){children.push(item);},
      classList:{toggle(){}},setAttribute(k:string,v:string){attrs.set(k,v);},getAttribute(k:string){return attrs.get(k);},
      contains(){return false;},focus(){},showModal(){this.open=true;},close(){this.open=false;},
      addEventListener(type:string,fn:any){handlers.set(id+':'+type,fn);}};
    nodes.set(id,value);return value;
  }
  node('confirmDeleteChart').textContent='Удалить';
  const library=attachChartLibrary({document,view:{update(){},show(){},hide(){},setScreen(){}},getCharts:()=>records as any,
    session:{get selectedId(){return selected;}} as any,removeChart(){localWrites++;},canEdit:()=>allowed,
    getConnectionMode:()=>mode,subscribeConnection(fn){changed=fn;return ()=>{};},onNew(){},onEdit(){},
    onSelect(id){selections.push(id);selected=id;},onUpdate(){},
    serverDeletion:{handles:()=>true,checking:()=>checks,
      submit:(id:string,signal:AbortSignal)=>new Promise(resolve=>requests.push({id,signal,resolve}))},
  });
  return {library,node,requests,selections,localWrites:()=>localWrites,
    get work(){return {queries,sourceReads};},
    addDelete(id='a'){const button=node('new-delete-'+actions.delete.length);button.dataset.actionChartId=id;actions.delete.push(button);return button;},
    open(id='a'){const menu={open:true};const action={dataset:{chartAction:'delete',actionChartId:id},closest:(selector:string)=>selector==='[data-chart-action]'?action:menu};handlers.get('document:click')!({target:action});},
    confirm:()=>handlers.get('confirmDeleteChart:click')!(),cancel:()=>handlers.get('cancelDeleteChart:click')!(),
    checking(value:boolean){checks=value;},select(id:string){selected=id;},
    offline(){mode='offline';changed();},online(){mode='online';changed();},deny(){allowed=false;library.render();},
  };
}

test('server deletion waits for confirmation, blocks a second click and never calls the local remover',async()=>{
  const h=harness();h.open();const pending=h.confirm();
  assert.equal(h.node('deleteChartDialog').open,true);assert.equal(h.node('confirmDeleteChart').disabled,true);
  await h.confirm();assert.equal(h.requests.length,1);assert.equal(h.localWrites(),0);
  h.requests[0].resolve({kind:'deleted'});await pending;
  assert.equal(h.node('deleteChartDialog').open,false);assert.deepEqual(h.selections,['current-transit']);
});
test('unknown deletion keeps the accepted waiting text and never offers another delete',async()=>{
  const h=harness();h.open();const pending=h.confirm();h.checking(true);h.requests[0].resolve({kind:'unknown'});await pending;
  assert.equal(h.node('deleteChartDialog').open,true);
  assert.equal(h.node('confirmDeleteChart').textContent,'Удалить');
  assert.equal(h.node('confirmDeleteChart').disabled,true);
  assert.equal(h.node('deleteChartError').textContent,UI_MESSAGES.chartDeleting);
  await h.confirm();assert.equal(h.requests.length,1);assert.deepEqual(h.selections,[]);
  h.offline();assert.equal(h.node('deleteChartError').textContent,UI_MESSAGES.offline);
  h.online();h.cancel();h.open();
  assert.equal(h.node('confirmDeleteChart').disabled,true);
  assert.equal(h.node('deleteChartError').textContent,UI_MESSAGES.chartDeleting);
});
test('closing a pending dialog invalidates its late presentation without disturbing a new dialog',async()=>{
  const h=harness();h.open();const pending=h.confirm();h.cancel();assert.equal(h.requests[0].signal.aborted,true);
  h.open('b');h.requests[0].resolve({kind:'deleted'});await pending;
  assert.equal(h.node('deleteChartDialog').open,true);assert.equal(h.node('deleteChartName').textContent,'«b»');assert.deepEqual(h.selections,[]);
});
test('server deletion cannot be initiated offline or after edit access is lost',async()=>{
  const h=harness();h.open();h.offline();await h.confirm();assert.equal(h.requests.length,0);assert.equal(h.node('confirmDeleteChart').disabled,true);
  h.deny();assert.equal(h.node('deleteChartDialog').open,false);
});


test('unchanged page updates do not scan the closed library or rewrite action availability', () => {
  const h=harness(); h.library.render();
  const before=h.work;
  for(let i=0;i<100;i++)h.library.render();
  assert.deepEqual(h.work,before);
  h.offline(); assert.ok(h.work.queries>before.queries, 'a connection change still updates the existing buttons');
});

test('new catalogue buttons receive the same availability immediately after their rows are inserted', () => {
  const h=harness();h.offline();
  const button=h.addDelete();
  assert.equal(button.disabled,false);
  h.library.refreshAvailability();
  assert.equal(button.disabled,true);
  h.online(); assert.equal(button.disabled,false);
});
