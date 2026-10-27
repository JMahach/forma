import type {TelegramStart} from '../../shared/account-contract.ts';
export interface TelegramSDK {
  auth(options:{client_id:string;nonce:string;scope:['profile'];lang:'ru'}, callback:(value:unknown)=>void):void;
  close?():void;
}
export interface TelegramPopup {authenticate(start:TelegramStart):Promise<string>;close():void}
export interface TelegramLogin {reserve(signal:AbortSignal,onCancel:()=>void):TelegramPopup;destroy():void}
const unavailable = () => Object.assign(new Error('telegram_unavailable'), {code:'telegram_unavailable'});
const cancelled = () => new DOMException('Cancelled', 'AbortError');
const SDK_URL = 'https://oauth.telegram.org/js/telegram-login.js?6';

/** Provider window only. This adapter never decodes identities, stores tokens or confirms an account. */
export function createTelegramLogin({window, now = Date.now}:{window:Window;now?:()=>number}):TelegramLogin {
  let loading:Promise<TelegramSDK>|null=null, active:TelegramPopup|null=null, destroyed=false;
  const sdk = () => (window as Window & {Telegram?:{Login?:TelegramSDK}}).Telegram?.Login;
  function load():Promise<TelegramSDK> {
    const current=sdk();
    if(typeof current?.auth==='function') return Promise.resolve(current);
    if(loading) return loading;
    const script=window.document.createElement('script');script.src=SDK_URL;script.async=true;
    loading=new Promise<TelegramSDK>((resolve,reject)=>{
      script.onload=()=>{
        script.onload=script.onerror=null;
        const ready=sdk();if(typeof ready?.auth==='function') resolve(ready);else reject(unavailable());
      };
      script.onerror=()=>{script.onload=script.onerror=null;script.remove();reject(unavailable());};
      window.document.head.append(script);
    });
    void loading.catch(()=>{loading=null;});
    return loading;
  }
  return {
    reserve(signal,onCancel) {
      signal.throwIfAborted();if(destroyed) throw unavailable();
      active?.close();
      // The SDK opens this exact named target. Reserve it during the original
      // user gesture, before server nonce creation, IndexedDB or script loading.
      const opened=window.open('about:blank','telegram_oidc_login','width=550,height=650');
      if(!opened) throw unavailable();
      const reserved=opened;
      let ended=false,started=false,used=false,deadline:number|undefined;
      let settle:((error:Error|null,token?:string)=>void)|null=null;
      const watch=window.setInterval(()=>{if(reserved.closed&&!ended){onCancel();close();}},200);
      function cleanup() {
        if(ended) return;ended=true;
        window.clearInterval(watch);if(deadline!==undefined) window.clearTimeout(deadline);
        signal.removeEventListener('abort',close);
        if(active===owner) {active=null;if(started) try{sdk()?.close?.();}catch{}}
        try{reserved.close();}catch{}
      }
      function close() {if(ended)return;const reject=settle;cleanup();reject?.(cancelled());}
      signal.addEventListener('abort',close,{once:true});
      const owner:TelegramPopup={
        close,
        authenticate(start) {
          if(ended||signal.aborted) return Promise.reject(cancelled());
          if(used) return Promise.reject(unavailable());used=true;
          return new Promise<string>((resolve,reject)=>{
            settle=(error,token)=>{if(error)reject(error);else resolve(token!);};
            const finish=(error:Error|null,token?:string)=>{if(ended)return;cleanup();settle?.(error,token);settle=null;};
            const {clientId,nonce,scope}=start.telegram;
            if(!/^[1-9][0-9]{0,19}$/.test(clientId)||!/^[A-Za-z0-9_-]{32,128}$/.test(nonce)
              ||scope.length!==1||scope[0]!=='profile'||!Number.isSafeInteger(start.attempt.expiresAt)) {
              finish(unavailable());return;
            }
            const expired=()=>Object.assign(new Error('attempt_expired'),{code:'attempt_expired'});
            const remaining=start.attempt.expiresAt-now();
            if(remaining<=0){finish(expired());return;}
            deadline=window.setTimeout(()=>finish(expired()),remaining);
            void load().then(provider=>{
              if(ended||signal.aborted)return;
              if(reserved.closed){onCancel();close();return;}
              if(now()>=start.attempt.expiresAt){finish(expired());return;}
              started=true;
              try {
                provider.auth({client_id:clientId,nonce,scope:['profile'],lang:'ru'},value=>{
                  if(ended||signal.aborted)return;
                  if(now()>=start.attempt.expiresAt){finish(expired());return;}
                  const data=value&&typeof value==='object'?value as {error?:unknown;id_token?:unknown}:null;
                  if(data?.error==='popup_closed'){onCancel();close();return;}
                  if(data?.error||typeof data?.id_token!=='string'||!data.id_token||data.id_token.length>16384){finish(unavailable());return;}
                  finish(null,data.id_token);
                });
              }catch{finish(unavailable());}
            },()=>finish(unavailable()));
          });
        },
      };
      active=owner;return owner;
    },
    destroy(){destroyed=true;active?.close();},
  };
}
