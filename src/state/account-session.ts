import type { AccountAccess } from '../application/ports.ts';
import type { TelegramLogin } from '../data/telegram-login.ts';
import type { AccountClient } from '../data/account-client.ts';
import type { AccountLogoutStore } from '../data/account-logout-store.ts';
import type { SavedAccountView } from '../data/view-store.ts';
import type { ConnectionMode } from '../data/http-transport.ts';
import { createAccountFlow, createAccountServerRequest, type AccountFlow } from './account-flow.ts';

export type AccountNotice = { kind: 'logout'; ids: string[] } | { kind: 'changed'; id: string };
interface Options {
  telegram?: Pick<TelegramLogin, 'reserve'>;
  client: AccountClient; logoutStore: AccountLogoutStore; connection: () => ConnectionMode;
  saved?: SavedAccountView | null; notify?: (notice: AccountNotice) => void;
}

function createLogoutQueue({client,logoutStore,connection}:Options) {
  const revoked=new Set<string>();let flushing:Promise<void>|null=null;
  const revoke=(ids:readonly string[])=>{for(const id of ids)revoked.add(id);};
  async function flush(){
    if(connection()!=='online')return;
    if(flushing)return flushing;
    flushing=(async()=>{for(const id of await logoutStore.list()){
      revoke([id]);await client.logout(id);await logoutStore.remove(id);
    }})();
    try{await flushing;}finally{flushing=null;}
  }
  return {flush,revoke,
    async enqueue(ids:readonly string[]){await logoutStore.add(ids);await flush();},
    async isRevoked(id:string){return revoked.has(id)||(await logoutStore.list()).includes(id);},
  };
}

function sessionRequest(client:AccountClient,queue:ReturnType<typeof createLogoutQueue>) {
  const request=createAccountServerRequest(client);
  return async(...[input,signal]:Parameters<typeof request>)=>{
    await queue.flush();signal.throwIfAborted();
    const result=await request(input,signal);
    return result.session && await queue.isRevoked(result.session.id) ? {screen:'guest' as const} : result;
  };
}

function readAccess(flow:AccountFlow):AccountAccess|null {
  const {identity,session}=flow.state;
  return identity?.id && session ? {accountId:identity.id,sessionId:session.id,
    ...(session.diagnosticProof?{diagnosticProof:session.diagnosticProof}:{})}:null;
}

function subscribeAccess(flow:AccountFlow,listener:(access:AccountAccess|null)=>void) {
  let previous:string|undefined;
  return flow.subscribe(()=>{
    const access=readAccess(flow),key=JSON.stringify(access);
    if(key===previous)return;
    previous=key;listener(access);
  });
}

async function receiveNotice(flow:AccountFlow,notice:AccountNotice) {
  if(notice.kind==='logout')await flow.logout(notice.ids);
  else if(notice.id!==flow.state.session?.id){
    // A cross-tab account change supersedes pending login; its busy state cannot drop the read.
    flow.cancel();await flow.retry();
  }
}

/** Account lifetime only. Chart/library owners receive changes at composition. */
export function createAccountSession({telegram,client,logoutStore,connection,saved=null,notify=()=>{}}:Options) {
  const queue=createLogoutQueue({client,logoutStore,connection});
  let receiving=0,acceptedId:string|null=null;
  const flow=createAccountFlow({telegram,saved,connection,now:client.now,request:sessionRequest(client,queue),
    onClose:async id=>{await client.cancel(id);},
    async onLogout(ids){
      queue.revoke(ids);
      if(!receiving)notify({kind:'logout',ids:[...ids]});
      await queue.enqueue(ids);
    },
  });
  flow.subscribe(state=>{
    const id=state.session?.id??null;
    if(id && id!==acceptedId && !receiving)notify({kind:'changed',id});
    acceptedId=id;
  });
  return {
    flow,getSession:()=>readAccess(flow),
    subscribeSession:(listener:(access:AccountAccess|null)=>void)=>subscribeAccess(flow,listener),
    async receive(notice:AccountNotice){
      receiving++;
      try{await receiveNotice(flow,notice);}finally{receiving--;}
    },
    async connectionChanged(){
      flow.connectionChanged();
      // Only an already requested logout can be replayed on reconnect.
      try{await queue.flush();}catch{/* Durable IDs remain pending. */}
    },
    refresh:()=>flow.retry(),
    destroy(){flow.destroy();logoutStore.close();},
  };
}
