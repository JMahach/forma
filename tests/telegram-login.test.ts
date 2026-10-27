import test from 'node:test';
import assert from 'node:assert/strict';
import {createTelegramLogin, type TelegramSDK} from '../src/data/telegram-login.ts';
import type {TelegramStart} from '../shared/account-contract.ts';
const start:TelegramStart={attempt:{id:'a'.repeat(32),expiresAt:1801000},telegram:{clientId:'12345678901',nonce:'n'.repeat(43),scope:['profile']}};
function fixture(){
  let active=true,closed=false,callback:((value:unknown)=>void)|undefined,time=1000;
  const scripts:any[]=[],opened:any[]=[],calls:any[]=[],timers=new Map<number,()=>void>();let seq=0;
  const popup={get closed(){return closed;},close(){closed=true;}};
  const sdk:TelegramSDK={auth(options,done){calls.push(options);callback=done;},close(){popup.close();}};
  const view:any={document:{createElement(){return {remove(){}};},head:{append(script:any){scripts.push(script);}}},
    open(url:string,name:string){assert.equal(active,true,'the reserved popup must be opened inside the original click');opened.push({url,name});return popup;},
    setInterval(fn:()=>void){timers.set(++seq,fn);return seq;},clearInterval(id:number){timers.delete(id);},
    setTimeout(fn:()=>void){timers.set(++seq,fn);return seq;},clearTimeout(id:number){timers.delete(id);}};
  const login=createTelegramLogin({window:view,now:()=>time}),controller=new AbortController();
  return {login,controller,scripts,opened,calls,popup,timers,
    reserve(){return login.reserve(controller.signal,()=>controller.abort());},
    releaseClick(){active=false;},load(){view.Telegram={Login:sdk};scripts[0].onload();},
    result(value:unknown){callback?.(value);},closed(){closed=true;for(const fn of [...timers.values()])fn();},
    setTime(value:number){time=value;},tick(){for(const fn of [...timers.values()])fn();},view};
}
const tick=async()=>{await Promise.resolve();await Promise.resolve();};

test('reserves synchronously before preparation and requests only profile with the server nonce',async()=>{
  const f=fixture(),popup=f.reserve();assert.equal(f.opened.length,1);assert.equal(f.opened[0].name,'telegram_oidc_login');
  f.releaseClick();const result=popup.authenticate(start);assert.equal(f.scripts.length,1);
  assert.equal(f.scripts[0].src,'https://oauth.telegram.org/js/telegram-login.js?6');
  f.load();await tick();assert.deepEqual(f.calls,[{client_id:start.telegram.clientId,nonce:start.telegram.nonce,scope:['profile'],lang:'ru'}]);
  f.result({id_token:'signed.token.value',user:{id:'untrusted',username:'untrusted'}});
  assert.equal(await result,'signed.token.value');assert.equal(f.popup.closed,true);assert.equal(f.timers.size,0);
});
test('cancellation during SDK loading closes its window and ignores the later load and callback',async()=>{
  const f=fixture(),popup=f.reserve(),result=popup.authenticate(start);f.controller.abort();
  await assert.rejects(result,{name:'AbortError'});f.load();await tick();assert.equal(f.calls.length,0);assert.equal(f.popup.closed,true);
});
test('closing the reserved popup cancels before a delayed server response can launch the SDK',async()=>{
  const f=fixture(),popup=f.reserve();f.closed();assert.equal(f.controller.signal.aborted,true);
  await assert.rejects(popup.authenticate(start),{name:'AbortError'});assert.equal(f.scripts.length,0);
});
test('a blocked popup fails before any SDK preparation',()=>{
  const f=fixture();f.view.open=()=>null;
  assert.throws(()=>f.reserve(),{code:'telegram_unavailable'});assert.equal(f.scripts.length,0);
});
test('expired attempt cannot be prolonged by a late SDK callback',async()=>{
  const f=fixture(),popup=f.reserve(),result=popup.authenticate(start);f.load();await tick();
  f.setTime(start.attempt.expiresAt);f.tick();await assert.rejects(result,{code:'attempt_expired'});
  f.result({id_token:'late.signed.token'});assert.equal(f.popup.closed,true);assert.equal(f.timers.size,0);
});
test('SDK cancellation is quiet and its untrusted error text never becomes application copy',async()=>{
  for(const value of [{error:'popup_closed'},{error:'provider error with private data'},{user:{id:'123'}}]){
    const f=fixture(),popup=f.reserve(),result=popup.authenticate(start);f.load();await tick();f.result(value);
    await assert.rejects(result,(error:Error & {code?:string})=>{
      assert.equal(error.message.includes('private'),false);
      assert.equal(value.error==='popup_closed'?error.name:error.code,value.error==='popup_closed'?'AbortError':'telegram_unavailable');return true;
    });
  }
});
