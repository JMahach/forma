import test from 'node:test';
import assert from 'node:assert/strict';
import {attachAccountView} from '../src/views/account.ts';
import {createAccountFlow,createAccountServerRequest} from '../src/state/account-flow.ts';
import {createAccountClient} from '../src/data/account-client.ts';
import {UI_MESSAGES} from '../src/ui/messages.ts';
function render(verified=false, options: Partial<Parameters<typeof createAccountFlow>[0]> = {}){
  const nodes:any[]=[];
  const document:any={activeElement:null,createElement:()=>node()};
  function node():any{
    let text='',children:any[]=[];
    const n:any={id:'',className:'',dataset:{},innerHTML:'',hidden:true,ownerDocument:document,
      setAttribute(){},getAttribute(){return null;},removeAttribute(){},replaceChildren(...next:any[]){children=next;text='';},append(child:any){children.push(child);},
      get textContent(){return text+children.map(c=>c.textContent).join('');},set textContent(v){text=v;children=[];},
      addEventListener(){},removeEventListener(){},remove(){},contains(){return false;},
      querySelector(selector:string){if(selector==='#accountEmail, #accountCode')return /id="account(?:Email|Code)"/.test(this.innerHTML)?node():null;return node();}};
    nodes.push(n);return n;
  }
  const page=node(),flow=createAccountFlow({connection:()=> 'online',saved:{email:'',attemptEmail:'',attemptId:'a'.repeat(32),step:'telegram',verificationPending:verified},request:async()=>({}),...options});
  const view=attachAccountView({page,flow,offline:()=>false});
  return {flow,messages:()=>nodes.filter(n=>!n.hidden).map(n=>n.textContent).join(' '),html:()=>nodes.find(n=>n.className==='account-study-content').innerHTML,close(){view.destroy();flow.destroy();}};
}
test('Telegram continuation uses existing controls without pretending an email code was sent',()=>{
  const h=render();assert.doesNotMatch(h.html(),/id="accountEmail"|id="accountCode"|Код отправлен|Отправим одноразовый код/);
  assert.match(h.html(),/Войти через Telegram/);assert.match(h.html(),/Назад/);h.close();
});
test('a verified Telegram continuation offers explicit confirmation instead of requesting email again',()=>{
  const h=render(true);assert.match(h.html(),/type="submit"[^>]*>Войти<\/button>/);
  assert.doesNotMatch(h.html(),/Получить код|Подтвердите почту/);h.close();
});


for (const provider of ['telegram','email'] as const) test(`${provider} provider refusal remains an error and releases the ordinary login controls`,async()=>{
  const calls:string[]=[];let closed=0;
  const code=provider==='telegram'?'telegram_unavailable':'code_send_failed';
  const client=createAccountClient({fetch:async(path)=>{
    calls.push(String(path));return Response.json({error:code},{status:503});
  }});
  const h=render(false,{saved:null,request:createAccountServerRequest(client),telegram:{reserve(){
    return {authenticate:async()=>{assert.fail('an unavailable provider must never authenticate');},close(){closed++;}};
  }}});
  await h.flow.begin();assert.match(h.html(),/id="accountEmail"/);
  if(provider==='telegram')await h.flow.telegram();
  else {h.flow.input('email','person@example.test');await h.flow.submit();}
  assert.deepEqual(calls,[provider==='telegram'?'/api/auth/telegram/start':'/api/auth/email/start']);
  assert.equal(h.flow.state.issue?.code,code);assert.equal(h.flow.state.busy,null);
  assert.equal(h.flow.state.screen,'guest');assert.equal(h.flow.state.identity,null);assert.equal(h.flow.state.session,null);
  assert.equal(h.flow.snapshot?.attemptId,null);
  assert.match(h.html(),/type="submit"[^>]*>[^<]+<\/button>/);
  assert.doesNotMatch(h.html(),/type="submit"[^>]*disabled|Код отправлен на|Подтверждена|Привязан<\//);
  assert.ok(h.messages().includes(provider==='telegram'?UI_MESSAGES.accountActionFailed:UI_MESSAGES.codeSendFailed));
  if(provider==='telegram')assert.equal(closed,1,'the unused reserved provider window is closed');
  h.close();
});
