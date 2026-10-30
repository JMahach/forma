import { parseDiagnosticResponse } from '../../shared/client-report-contract.ts';
import type { DiagnosticQueue, DiagnosticQueueEntry } from './diagnostic-queue.ts';
import type { DiagnosticTransport } from './diagnostic-client.ts';
import { getConnectionMode, type ConnectionMode } from './http-transport.ts';

interface Options {queue:DiagnosticQueue;send:DiagnosticTransport;connection?:()=>ConnectionMode;visible?:()=>boolean;now?:()=>number;
  newId?:()=>string;timeoutMs?:number}

/** One local runner with an IndexedDB lease shared by tabs. Empty queues have no network timer. */
export function createDiagnosticDelivery({queue,send,connection=getConnectionMode,visible=()=>true,now=Date.now,
  newId=()=>crypto.randomUUID(),timeoutMs=10_000}:Options) {
  if(!Number.isFinite(timeoutMs) || timeoutMs<=0 || timeoutMs>10_000)throw new RangeError('Invalid diagnostic deadline');
  const owner=newId();
  let stopped=false,closed=false,requested=false,work:Promise<void>|null=null,closing:Promise<void>|null=null;
  let localFailures=0,localRetryAt=0;
  let occasionAt:number|undefined;
  let timer:ReturnType<typeof setTimeout>|undefined,active:AbortController|null=null,exitController:AbortController|null=null;
  let leaving:ReturnType<DiagnosticQueue['clearForExit']>|null=null;
  let exitWork:Promise<void>|null=null;
  const online=()=>{try{return visible() && connection()==='online';}catch{return false;}};
  function schedule(at:number){clearTimeout(timer);timer=undefined;if(stopped || !online())return;
    timer=setTimeout(()=>{timer=undefined;void wake(false);},Math.max(0,Math.min(2**31-1,at-now())));
    (timer as unknown as {unref?():void})?.unref?.();
  }
  // A failed IDB commit cannot persist the shared pause. Keep one bounded local
  // pause too, so losing the ACK locally does not turn a working network into a loop.
  function storagePause(retryAfterMs=0){localFailures++;const delay=localFailures===1?1000:localFailures===2?5000:60_000;
    localRetryAt=now()+Math.max(delay,Number.isFinite(retryAfterMs)?retryAfterMs:0);
    if(localFailures<3)schedule(localRetryAt);}
  async function transmit(entries:readonly DiagnosticQueueEntry[],controller:AbortController,exit:boolean) {
    let reject!:(reason:unknown)=>void;
    const interrupted=new Promise<never>((_resolve,no)=>{reject=no;});
    const abort=()=>reject(controller.signal.reason ?? new Error('Diagnostic delivery stopped'));
    controller.signal.addEventListener('abort',abort,{once:true});
    const deadline=setTimeout(()=>controller.abort(new Error('Diagnostic delivery deadline')),timeoutMs);
    try {
      if(controller.signal.aborted)throw controller.signal.reason;
      const body=Object.freeze({schemaVersion:1 as const,reports:Object.freeze(entries.map(entry=>entry.report))});
      const diagnosticProof=entries.find(entry=>entry.diagnosticProof)?.diagnosticProof;
      return await Promise.race([send(body,{signal:controller.signal,exit,...(diagnosticProof?{diagnosticProof}:{})}),interrupted]);
    }finally{clearTimeout(deadline);controller.signal.removeEventListener('abort',abort);}
  }
  async function pump(wakeAt:number|undefined) {
    // Yield between bounded groups even when a synthetic transport resolves synchronously.
    for(let batches=0;batches<4 && !stopped && online();batches++) {
      const batch=await queue.claim(owner,wakeAt);if(stopped || !online()){await queue.release(owner);return;}
      if(batch.status==='waiting'){schedule(batch.retryAt);return;}
      if(batch.status!=='batch'){if(batch.status==='unavailable')storagePause();return;}
      const controller=new AbortController();active=controller;
      try {
        const response=parseDiagnosticResponse(await transmit(batch.entries,controller,false));
        if(stopped || !online()){await queue.release(owner);return;}
        const sent=new Set(batch.entries.map(entry=>entry.eventId));
        if(!response || response.results.some(result=>!sent.has(result.eventId)))throw new Error('Invalid diagnostic response');
        const terminal=response.results.filter(result=>result.status==='accepted' || result.status==='invalid').map(result=>result.eventId);
        const result=await queue.finish(batch.token,batch.entries,terminal,terminal.length===batch.entries.length?'none':'partial');
        if(result.status!=='finished'){if(result.status==='unavailable'){storagePause();await queue.release(owner);}return;}
        localFailures=0;localRetryAt=0;
      }catch(error) {
        if(stopped || !online()){await queue.release(owner);return;}
        const retryAfterMs=(error as {retryAfterMs?:number}|null)?.retryAfterMs;
        const result=await queue.finish(batch.token,batch.entries,[],'transport',retryAfterMs);
        if(result.status!=='finished'){if(result.status==='unavailable'){storagePause(retryAfterMs);await queue.release(owner,retryAfterMs);}return;}
        localFailures=0;localRetryAt=0;
      }finally{if(active===controller)active=null;}
    }
    if(!stopped && online())schedule(now());
  }
  function wake(external:boolean|number=true):Promise<void> {
    if(stopped || !online()){clearTimeout(timer);timer=undefined;active?.abort();return work??Promise.resolve();}
    if(external!==false)occasionAt=typeof external==='number'?external:now();
    if(localFailures>=3){if(occasionAt===undefined || occasionAt<localRetryAt)return work??Promise.resolve();localFailures=0;}
    if(localRetryAt>now()){schedule(localRetryAt);return work??Promise.resolve();}
    clearTimeout(timer);timer=undefined;
    if(work){requested=true;return work;}
    requested=false;const wakeAt=occasionAt;occasionAt=undefined;
    work=pump(wakeAt).catch(()=>storagePause()).finally(()=>{work=null;if(requested && !stopped && timer===undefined)schedule(now());});
    return work;
  }
  const unsubscribe=queue.subscribe(()=>{void wake(false);});
  void wake(false);
  return {
    /** Only a new app/connection/hourly occasion may reopen an exhausted series.
     * Internal queue changes and finite timers pass false; they never grant a fresh budget. */
    wake,
    /** Atomically detach one shared bounded attempt and clear the old epoch. Never wait for its ACK.
     * Clear the report adapter's RAM context synchronously before calling this method. A new account
     * needs a fresh queue/adapter handle; old handles cannot adopt its epoch after a late callback. */
    leave(scopes?:readonly (string|null)[]) {
      if(leaving)return leaving;
      stopped=true;clearTimeout(timer);timer=undefined;active?.abort();unsubscribe();
      leaving=queue.clearForExit(true,scopes).then(result=>{
        if(!closed && result.status==='cleared' && result.entries.length) {
          const controller=new AbortController();exitController=controller;
          exitWork=transmit(result.entries,controller,true).then(()=>{},()=>{}).finally(()=>{
            if(exitController===controller)exitController=null;
          });
        }
        return result;
      });
      return leaving;
    },
    close({finishExit=false}:{finishExit?:boolean}={}):Promise<void> {
      if(!finishExit)exitController?.abort();
      if(closing)return closing;
      closed=true;stopped=true;clearTimeout(timer);timer=undefined;unsubscribe();active?.abort();
      closing=(async()=>{await work;if(finishExit)await exitWork;await queue.release(owner);})();return closing;
    },
  };
}
