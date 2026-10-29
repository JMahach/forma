import { browserMetadata, attachBrowserSource, type BrowserSource, type BrowserNavigator } from './diagnostics/browser-source.ts';
import type { StorageRelief } from './data/storage-pressure.ts';
import { createClientReports, clientFailureReason } from './diagnostics/client-reports.ts';
import { createDiagnosticQueue, type DiagnosticQueue } from './data/diagnostic-queue.ts';
import { createDiagnosticDelivery } from './data/diagnostic-delivery.ts';
import { createDiagnosticClient, type DiagnosticTransport } from './data/diagnostic-client.ts';
import { getConnectionMode, type ConnectionMode } from './data/http-transport.ts';
import { parseClientContextStep, type ClientReportMetadata, type ClientContextStep, type ClientActionContext } from '../shared/client-report-contract.ts';

interface Options {
  appVersion:string;environment:ClientReportMetadata['environment'];accountId?:string|null;sessionId?:string|null;diagnosticProof?:string;
  indexedDB?:IDBFactory|null;send?:DiagnosticTransport;connection?:()=>ConnectionMode;now?:()=>number;monotonicNow?:()=>number;
}
type Delivery=ReturnType<typeof createDiagnosticDelivery>;
interface Owner {accountId:string|null;diagnosticProof?:string;queue:DiagnosticQueue;generation:number;scope:string|null|undefined;epoch:number|null;activated:boolean;delivery:Delivery|null;closing:Promise<void>|null;
  initializing:Promise<'ready'|'unavailable'|'stale'>|null}
interface Cleanup {owner:Owner;scopes:readonly (string|null)[]|undefined;attempted:boolean;first:ReturnType<Delivery['leave']>|null}

/** Browser composition only. Callers provide trusted build metadata and account
 * transitions; attachBrowser explicitly connects one replaceable browser source. */
export function createJournal({appVersion,environment,accountId=null,sessionId,diagnosticProof,indexedDB,
  send=createDiagnosticClient(),connection=getConnectionMode,now=Date.now,monotonicNow}:Options) {
  let currentAccount=accountId,lastAccount=accountId,generation=0,closed=false,unknownCleanup=false;
  let currentScope:string|null|undefined=accountId===null?null:sessionId??undefined;
  let currentProof=diagnosticProof;
  let active:Owner|null=null,cleanup:Cleanup|null=null,retiring:Owner|null=null;
  let work:Promise<void>|null=null,closing:Promise<void>|null=null,requested=false;
  let failures=0,retryAt=0,timer:ReturnType<typeof setTimeout>|undefined;
  let environmentMetadata:Pick<ClientReportMetadata,'browser'|'os'|'device'>={},detachBrowser:(()=>void)|null=null;
  const current=(owner:Owner)=>!closed && active===owner && generation===owner.generation && !cleanup;
  const reports=createClientReports({metadata:()=>({appVersion,environment,accountId:currentAccount,...environmentMetadata}),now,monotonicNow,
    enqueue:async report=>{const owner=active;if(!owner || !current(owner))return false;
      // Await this owner only, never the runner's network pump or a replacement
      // account. Startup can report immediately without blocking the main UI.
      if(await prepare(owner)!=='ready' || !current(owner))return false;
      return (await owner.queue.enqueue(report,report.accountId===null?undefined:owner.diagnosticProof)).status==='queued';},
  });
  function createOwner():Owner{return {accountId:lastAccount,diagnosticProof:currentProof,queue:createDiagnosticQueue({indexedDB,now}),generation,scope:currentScope,epoch:null,activated:false,delivery:null,closing:null,initializing:null};}
  function prepare(owner:Owner):Promise<'ready'|'unavailable'|'stale'> {
    if(!current(owner))return Promise.resolve('stale');
    if(owner.activated)return Promise.resolve('ready');
    if(owner.initializing)return owner.initializing;
    const scope=owner.scope;
    owner.initializing=(async()=>{
      const snapshot=await owner.queue.state();if(!current(owner))return 'stale' as const;
      if(snapshot.status!=='ready')return snapshot.status;
      owner.epoch=snapshot.epoch;
      const activated=await owner.queue.activate(snapshot.epoch,()=>current(owner) && owner.scope===scope,scope,owner.accountId);
      if(!current(owner) || owner.scope!==scope)return 'stale' as const;
      if(!activated)return 'unavailable' as const;
      owner.activated=true;return 'ready' as const;
    })().catch(()=>'unavailable' as const).finally(()=>{owner.initializing=null;});
    return owner.initializing;
  }
  function sender(owner:Owner){return owner.delivery??=createDiagnosticDelivery({queue:owner.queue,send,connection,now});}
  function dispose(owner:Owner,finishExit=false):Promise<void> {
    // A forced close also cancels an earlier graceful teardown. At most one
    // detached exit request survives while the current owner is running.
    const stopped=owner.delivery?.close({finishExit})??Promise.resolve();
    owner.closing??=stopped.finally(()=>owner.queue.close());return owner.closing;
  }
  function retire(owner:Owner) {
    if(retiring && retiring!==owner)void dispose(retiring);
    retiring=owner;void dispose(owner,true).finally(()=>{if(retiring===owner)retiring=null;});
  }
  function schedule(){clearTimeout(timer);if(closed)return;
    timer=setTimeout(()=>{timer=undefined;void wake();},Math.max(0,Math.min(2**31-1,retryAt-now())));
    (timer as unknown as {unref?():void})?.unref?.();
  }
  function pause(){failures++;retryAt=now()+Math.min(60_000,1000*2**Math.min(failures-1,6));schedule();}
  function cleared(intent:Cleanup){if(cleanup!==intent || closed)return;cleanup=null;failures=0;retryAt=0;retire(intent.owner);}
  async function clearStep(intent:Cleanup) {
    const owner=intent.owner;
    // A public login scope lets a cold exit identify only its own generation.
    // Unknown legacy callers remain fail-closed; app supplies logout session IDs.
    if(owner.epoch===null && !intent.scopes?.length)return;
    let result:Awaited<ReturnType<Delivery['leave']>>;
    if(intent.first){const first=intent.first;intent.first=null;result=await first;}
    else {
      if(!owner.activated && !intent.scopes?.length) {
        const snapshot=await owner.queue.state();if(closed || cleanup!==intent)return;
        if(snapshot.status!=='unavailable' && snapshot.epoch>owner.epoch!){cleared(intent);return;}
        if(snapshot.status!=='ready'){intent.attempted=true;pause();return;}
        owner.activated=await owner.queue.activate(owner.epoch!,()=>!closed && cleanup===intent);
        if(closed || cleanup!==intent)return;
        if(!owner.activated){intent.attempted=true;pause();return;}
      }
      if(!intent.attempted){intent.attempted=true;result=await sender(owner).leave(intent.scopes);}
      else result=await owner.queue.clearForExit(false,intent.scopes);
    }
    if(closed || cleanup!==intent)return;
    if(result.status==='cleared' || result.status==='stale')cleared(intent);else pause();
  }
  async function advance() {
    if(unknownCleanup)return;
    if(cleanup){await clearStep(cleanup);if(cleanup || closed)return;}
    const owner=active??=createOwner();
    const prepared=await prepare(owner);if(!current(owner))return;
    if(prepared!=='ready'){if(prepared==='unavailable')pause();return;}failures=0;retryAt=0;
    if(current(owner))await sender(owner).wake();
  }
  function wake():Promise<void> {
    if(closed || unknownCleanup)return Promise.resolve();
    if(retryAt>now()){schedule();return work??Promise.resolve();}
    clearTimeout(timer);timer=undefined;
    if(work){requested=true;return work;}
    requested=false;work=advance().catch(()=>pause()).finally(()=>{work=null;
      if(requested && !closed && timer===undefined){requested=false;void wake();}
    });return work;
  }
  function boundary(ids?:readonly string[]) {
    generation++;reports.clearContext();clearTimeout(timer);timer=undefined;retryAt=0;failures=0;
    if(!cleanup) {
      const owner=active;active=null;
      if(!owner){unknownCleanup=true;return {status:'unavailable' as const};}
      const scopes=ids?.length?ids:owner.scope===undefined?undefined:[owner.scope];
      cleanup={owner,scopes,attempted:!!owner.delivery,first:owner.delivery?.leave(scopes)??null};
    }
    void wake();
    return {status:cleanup.owner.epoch===null?'unavailable' as const:'pending' as const};
  }
  // Creation also stays inside the optional background path: even reading the
  // browser's indexedDB property can throw when site storage is prohibited.
  void wake();
  function begin(action:ClientActionContext,observedAt?:number) {
    const handle=reports.begin(action,observedAt);
    return {...handle,async reportError(error:unknown,step:Omit<ClientContextStep,'reason'>) {
      const parsed=parseClientContextStep(step);if(!parsed || Object.hasOwn(parsed,'reason'))return null;
      const reason=clientFailureReason(error);
      return handle.reportFailure({...parsed,reason,...(reason==='outcome_unknown'?{outcome:'unknown' as const}:{})});
    }};
  }
  return {
    begin,
    attachBrowser(target:BrowserSource,navigator:BrowserNavigator) {
      detachBrowser?.();detachBrowser=null;
      if(closed)return ()=>{};
      environmentMetadata=browserMetadata(navigator);
      const detach=attachBrowserSource(target,(error,stage)=>{
        void begin({action:'runtime',component:'runtime'}).reportError(error,{stage}).catch(()=>{});
      });
      detachBrowser=detach;
      return ()=>{if(detachBrowser===detach){detachBrowser=null;detach();}};
    },
    setAccount(next:string|null,nextSessionId?:string|null,nextProof?:string) {
      const scope=next===null?currentScope:nextSessionId??undefined;
      if(closed || next===currentAccount && scope===currentScope && (next===null || nextProof===currentProof))return;
      const changesAccount=next!==null && lastAccount!==null && next!==lastAccount;
      currentAccount=next;currentScope=scope;if(next!==null){lastAccount=next;currentProof=nextProof;}
      if(changesAccount)boundary();else {
        reports.clearContext();
        if(active && next!==null){active.accountId=next;active.diagnosticProof=nextProof;}
        if(active && active.scope!==scope){active.scope=scope;active.activated=false;retryAt=0;void wake();}
      }
    },
    leave(ids?:readonly string[]){if(closed)return {status:'unavailable' as const};currentAccount=null;lastAccount=null;currentScope=null;currentProof=undefined;return boundary(ids);},
    wake,
    async discardForSpace(isCurrent:()=>boolean=()=>true):Promise<StorageRelief> {
      const owner=active;
      if(!owner || !current(owner) || await prepare(owner)!=='ready' || !current(owner))return 'unavailable';
      return owner.queue.discardForSpace(()=>current(owner)&&isCurrent());
    },
    close():Promise<void> {
      if(closing)return closing;
      closed=true;generation++;detachBrowser?.();detachBrowser=null;reports.close();clearTimeout(timer);timer=undefined;
      const owners=new Set([active,cleanup?.owner,retiring].filter((owner):owner is Owner=>!!owner));
      const stopped=[...owners].map(owner=>dispose(owner));
      closing=(async()=>{await Promise.all(stopped);await work;})();return closing;
    },
  };
}
