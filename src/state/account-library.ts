import type { AccountChart } from '../../shared/chart-record-contract.ts';
import type { ChartClient } from '../data/chart-client.ts';
import type { AccountLibraryStore, LibraryLease,LibrarySnapshot,LibraryCatalogBase } from '../data/account-library-store.ts';
import type {LibraryCatalogRead} from './library-reconciliation.ts';
import type {LibraryCatalogSnapshot,LibraryCatalogEntry} from '../../shared/library-catalog-contract.ts';
import {isLibraryCatalogMarker} from '../../shared/library-catalog-contract.ts';
import type {CheckAuthority} from '../domain/background-check.ts';
import {readCompleteLibraryCatalog,projectLibraryEntries,libraryRecordEntry,sameLibrarySession,sameWorkingLease,catalogIsOlder,mergeLibraryRecords,parseLibraryNotice,type LibrarySession,type LibraryNotice} from './library-reconciliation.ts';

export type {LibrarySession,LibraryNotice} from './library-reconciliation.ts';
interface Options {
  client: Pick<ChartClient, 'catalog' | 'confirmCatalog' | 'own'>; storage: AccountLibraryStore;
  online: () => boolean; restoreAllowed?: () => Promise<boolean>; notify?: (notice:LibraryNotice) => void;
}
interface CatalogRun {seen:number;content:number;access:LibrarySession;signal:AbortSignal;authority?:CheckAuthority}
interface CatalogLoading {run:CatalogRun;promise:Promise<LibraryRefreshResult>}
const failed = (code: string) => Object.assign(new Error(code), {code});
const codeOf = (error: unknown) => (error as {code?: string} | null)?.code;
export type LibraryRefreshResult={status:'complete'|'unchanged';durable:boolean}|{status:'inactive'|'unstable'|'superseded'};

/** One working account library. Acquisition and persistence never choose the visible chart. */
class AccountLibraryOwner {
 private options:Required<Options>;
 private records:AccountChart[]=[];
 private rows:readonly LibraryCatalogEntry[]=[];
 private ownerId:string|null=null;
 private current:LibrarySession|null=null;
 private lease:LibraryLease|null=null;
 private generation=0;
 private available=true;
 private closed=false;
 private catalog:LibraryCatalogSnapshot|null=null;
 private contentGeneration=0;
 private minimumMarker='0';
 private catalogComplete=false;
 private controller=new AbortController();
 private loading:CatalogLoading|null=null;
 private removals={pending:new Map<string,Promise<void>>(),tail:Promise.resolve()};
 private listeners=new Set<()=>void>();
 private published:unknown[];
 constructor(options:Options){
  this.options={restoreAllowed:async()=>true,notify:()=>{},...options};
  this.published=this.observable();
  this.has=this.has.bind(this);
  this.isReady=this.isReady.bind(this);
  this.subscribe=this.subscribe.bind(this);
  this.get=this.get.bind(this);
  this.restore=this.restore.bind(this);
  this.connect=this.connect.bind(this);
  this.load=this.load.bind(this);
  this.canRestore=this.canRestore.bind(this);
  this.markOpened=this.markOpened.bind(this);
  this.open=this.open.bind(this);
  this.prepareAcceptance=this.prepareAcceptance.bind(this);
  this.forget=this.forget.bind(this);
  this.clear=this.clear.bind(this);
  this.retryClear=this.retryClear.bind(this);
  this.receive=this.receive.bind(this);
  this.refreshLocal=this.refreshLocal.bind(this);
  this.close=this.close.bind(this);
 }
 private advance(marker:string) {if(BigInt(marker)>BigInt(this.minimumMarker))this.minimumMarker=marker;}
 private older(marker:string) {return BigInt(marker)<BigInt(this.minimumMarker);}
 private announce(detail:Omit<Extract<LibraryNotice,{kind:'record'}>,'accountId'|'sessionId'>|Omit<Extract<LibraryNotice,{kind:'removed'}>,'accountId'|'sessionId'>|Omit<Extract<LibraryNotice,{kind:'catalog'}>,'accountId'|'sessionId'>){
    if(this.current)this.options.notify({...this.current,...detail});
  }
 private observable() {return [this.records, this.rows, this.ownerId, this.available, this.current?.accountId, this.current?.sessionId, this.lease?.generation];}
 private emit(durableChanged = false) {
    this.rows=projectLibraryEntries(this.catalog,this.records,this.rows);
    const next = this.observable();
    if (!durableChanged && next.every((value, index) => value === this.published[index])) return;
    this.published = next;
    for (const listener of this.listeners) listener();
  }
 private retainList(next: AccountChart[]) {
    if (next.length !== this.records.length || next.some((chart, index) => chart !== this.records[index])) this.records = next;
  }
 private invalidate(keepRemovals = false) {
    this.generation++; this.controller.abort(); this.controller = new AbortController(); this.loading = null;
    if (!keepRemovals) this.removals = {pending: new Map(), tail: Promise.resolve()};
  }
 private check(seen: number) { if (this.closed || seen !== this.generation) throw failed('account_changed'); }
 private resetWorking(accountId:string|null=null) {
  this.ownerId=accountId;this.lease=null;this.records=[];this.catalog=null;this.minimumMarker='0';this.catalogComplete=false;
 }
 private readStoredCatalog(snapshot:LibrarySnapshot) {
  const usable=snapshot.catalog && !this.older(snapshot.catalog.marker);
  if(usable){this.catalog=snapshot.catalog!;this.catalogComplete=snapshot.catalogComplete!==false;this.advance(this.catalog.marker);}
  this.advance(snapshot.minimumMarker??'0');
  return usable && snapshot.catalogComplete?new Set(snapshot.catalog!.entries.map(row=>row.id)):null;
 }
 private storedRecords(snapshot:LibrarySnapshot,observedId?:string) {
  if(!catalogIsOlder(snapshot.catalog,this.catalog) && !this.older(snapshot.minimumMarker??'0'))return snapshot.charts;
  const known=new Set([...this.catalog?.entries??[],...this.records].map(row=>row.id));
  if(observedId)known.add(observedId);
  return snapshot.charts.filter(chart=>known.has(chart.id));
 }
 private mergeLocal(snapshot:LibrarySnapshot,memoryOnly:boolean,observedId?:string) {
  const same=sameWorkingLease(this.lease,snapshot.lease);
  const behind=this.older(snapshot.minimumMarker??'0'),retainMissing=same || memoryOnly || behind;
  // Old disk content can enrich known rows, but cannot restore an ID already
  // absent from the newer working projection after a failed catalog commit.
  const stored=this.storedRecords(snapshot,observedId);
  const present=this.readStoredCatalog(snapshot);
  this.retainList(mergeLibraryRecords(this.records,stored,this.removals.pending,retainMissing,present));
  this.lease=snapshot.lease;this.ownerId=this.lease?.accountId??null;
 }
 private async readLocal(valid:()=>void,accountId=this.current?.accountId,publish=true,observedId?:string) {
  const memoryOnly=!this.available,snapshot=await this.options.storage.read();valid();
  this.available=!!snapshot;
  if(!snapshot){this.emit();return false;}
  if(accountId && snapshot.lease?.accountId!==accountId){this.invalidate();this.resetWorking();this.emit();return false;}
  this.mergeLocal(snapshot,memoryOnly,observedId);if(publish)this.emit();return true;
 }
 async refreshLocal() {
    const seen = this.generation; await this.readLocal(() => this.check(seen));
  }
 private newerRecord(chart:AccountChart) {const prior=this.get(chart.id);return !prior || prior.revision<chart.revision;}
 private async accept(chart:AccountChart,seen:number,expectedLease:LibraryLease|null,marker:string) {
  this.check(seen);
  if(chart.accountId!==this.ownerId)throw failed('account_changed');
  if(this.older(marker))throw failed('library_changed');this.advance(marker);
  if(this.newerRecord(chart))this.contentGeneration++;
  const durableChanged=await this.persistRecord(chart,seen,expectedLease,marker);
  if(this.older(marker))throw failed('library_changed');
  const changed=this.newerRecord(chart);
  if(changed){const rows=new Map(this.records.map(row=>[row.id,row]));rows.set(chart.id,chart);this.retainList([...rows.values()]);}
  this.emit(durableChanged);
  if(changed || durableChanged)this.announce({kind:'record',entry:libraryRecordEntry(chart,this.rows.find(row=>row.id===chart.id)),marker,durable:this.available});
 }
 private async persistRecord(chart:AccountChart,seen:number,expectedLease:LibraryLease|null,marker:string) {
  if(!expectedLease)return false;
  let result=await this.options.storage.put(expectedLease,[chart],marker);this.check(seen);
  if(result.status==='stale'){
   await this.refreshLocal();this.check(seen);
   if(!this.lease || !this.currentAcquisition(chart,marker))throw failed('library_changed');
   result=await this.options.storage.put(this.lease,[chart],marker);this.check(seen);
   if(result.status==='stale')throw failed('library_changed');
  }
  this.available=result.status==='stored';
  return (result.status==='stored' || result.status==='partial') && result.changed!==false;
 }
 private currentAcquisition(chart:AccountChart,marker:string) {
  if(BigInt(marker)>BigInt(this.minimumMarker))return true;
  if(!this.catalogComplete || this.catalog?.marker!==marker || this.older(marker))return false;
  const row=this.catalog.entries.find(row=>row.id===chart.id);
  return !!row && row.revision<=chart.revision;
 }
 private checkRemoval(marker:string,proof:'absence'|'deleted') {
  if(proof==='absence' && this.older(marker))throw failed('library_changed');
 }
 forget(chartId: string,marker=this.minimumMarker,proof:'absence'|'deleted'='absence'): Promise<void> {
    // An issued ID is never reused. A committed deletion remains true even
    // when an unrelated record advanced the library marker in the meantime.
    try{this.checkRemoval(marker,proof);}catch(error){return Promise.reject(error);}
    this.advance(marker);this.catalogComplete=false;
    const scope = this.removals, accountId = this.ownerId, pending = scope.pending.get(chartId);
    if (pending) return pending;
    if (!accountId) return Promise.resolve();
    // Fence old reads immediately, while other confirmed deletions keep their
    // own work. Only account/session changes revoke this deletion scope.
    this.invalidate(true);
    this.contentGeneration++;
    if(this.catalog)this.catalog={...this.catalog,entries:this.catalog.entries.filter(row=>row.id!==chartId)};
    const valid = () => {
      if (this.closed || scope !== this.removals || this.ownerId !== accountId) throw failed('account_changed');
    };
    const work = scope.tail.then(async () => {
      valid();this.checkRemoval(marker,proof);
      await this.removeStored(chartId,marker,accountId,valid,proof);
      this.checkRemoval(marker,proof);
      this.announce({kind:'removed',marker,chartId,durable:this.available});
    }).catch(async error=>{
      if(codeOf(error)==='library_changed'){
        scope.pending.delete(chartId);valid();await this.readLocal(valid,accountId);
      }
      throw error;
    }).finally(() => { scope.pending.delete(chartId); });
    scope.pending.set(chartId, work);
    scope.tail = work.catch(() => {});
    this.records = this.records.filter(chart => chart.id !== chartId); this.emit();
    return work;
  }
 private async removeStored(chartId:string,marker:string,accountId:string,valid:()=>void,proof:'absence'|'deleted') {
      while (this.lease) {
        this.checkRemoval(marker,proof);
        const result = await this.options.storage.remove(this.lease, chartId,marker,proof); valid();
        if(result.status==='superseded')throw failed('library_changed');
        if (result.status === 'stored') { this.lease = result.lease; break; }
        if (result.status === 'unavailable') { this.available = false; this.lease = null; break; }
        // Another deletion advanced the lease. Re-read the same account and
        // retry this exact confirmed target; never acquire another account.
        const refreshed = await this.readLocal(valid, accountId); valid();
        if (!refreshed) { this.lease = null; break; }
      }
 }
 isReady(id:string) {
    const chart=this.records.find(row=>row.id===id),entry=this.rows.find(row=>row.id===id);
    return !!chart && (!entry || chart.revision>=entry.revision);
  }
 async open(chartId: string, consumerSignal?: AbortSignal): Promise<AccountChart> {
    consumerSignal?.throwIfAborted();
    const cached = this.records.find(chart => chart.id === chartId);
    if (!this.options.online() || !this.current) {
      if (cached && this.isReady(chartId)) return cached;
      throw failed(this.options.online() ? 'auth_required' : 'offline');
    }
    const signal = consumerSignal ? AbortSignal.any([this.controller.signal, consumerSignal]) : this.controller.signal;
    return this.readOwn(chartId,signal,cached);
  }
 private async readOwn(chartId:string,signal:AbortSignal,cached:AccountChart|undefined):Promise<AccountChart> {
    const seen=this.generation,target=this.lease;
    const valid = () => { this.check(seen); signal.throwIfAborted(); };
    try {
      const read = await this.options.client.own({chartId, expectedAccountId: this.current!.accountId}, signal);
      valid(); await this.accept(read.chart, seen, target,read.catalogMarker); valid(); return this.records.find(value => value.id === chartId)!;
    } catch (error) {
      valid();return this.failedOpen(error,chartId,cached);
    }
  }
 private async failedOpen(error:unknown,chartId:string,cached:AccountChart|undefined):Promise<AccountChart> {
      if (codeOf(error) === 'not_found') {
        const marker=(error as {details?:{catalogMarker?:unknown}}).details?.catalogMarker;
        if(isLibraryCatalogMarker(marker))await this.forget(chartId,marker);
      }
      else if (['offline','connection_failed','server_unavailable'].includes(codeOf(error) ?? '') && cached && this.isReady(chartId)) return cached;
      throw error;
  }
 get charts(): readonly AccountChart[] { return this.records; }
 get entries(){return this.rows;}
 get readyIds() {
  const revisions=new Map(this.rows.map(row=>[row.id,row.revision]));
  return this.records.filter(chart=>chart.revision>=(revisions.get(chart.id)??0)).map(chart=>chart.id);
 }
 has(id:string) {return this.rows.some(row=>row.id===id);}
 get accountId() { return this.ownerId; }
 get session() { return this.current; }
 get storageAvailable() { return this.available; }
 subscribe(listener: () => void) { this.listeners.add(listener); listener(); return () => { this.listeners.delete(listener); }; }
 get(id: string) {return this.records.find(chart => chart.id === id);}
 async restore() {
      const seen = this.generation;
      if (!await this.options.restoreAllowed()) { this.check(seen); return; }
      this.check(seen); await this.refreshLocal();
    }
 async connect(value: LibrarySession | null) {
      if (sameLibrarySession(this.current,value)) return;
      this.invalidate(); const seen = this.generation;
      this.current = value ? {...value} : null;
      if (!value) { this.emit(); return; } // Expiry is not an explicit logout.
      if (this.ownerId !== value.accountId) { this.resetWorking(value.accountId); this.emit(); }
      const result = await this.options.storage.activate(value.accountId); this.check(seen);
      this.available = result.status === 'stored';
      this.lease = result.status === 'stored' ? result.lease : null;
      if (this.lease) await this.refreshLocal();
      else this.emit();
    }
 private catalogRunCurrent(run:CatalogRun,marker:string) {
  this.check(run.seen);return run.content===this.contentGeneration && !this.older(marker);
 }
 private async checkCatalogRun(run:CatalogRun) {
  this.check(run.seen);run.signal.throwIfAborted();
  if(run.authority){
   if(run.authority.permit.sessionId!==run.access.sessionId)throw new DOMException('Background check cancelled','AbortError');
   const current=await run.authority.current();
   this.check(run.seen);run.signal.throwIfAborted();
   if(!current)throw new DOMException('Background check cancelled','AbortError');
  }
 }
 private async saveCatalog(base:LibraryCatalogBase|null,read:Exclude<LibraryCatalogRead,{status:'unstable'}>,run:CatalogRun):Promise<LibraryRefreshResult> {
  const authority=run.authority && {...run.authority,signal:run.signal};
  const saved=base?await this.options.storage.putCatalog(base,read.catalog,authority):{status:'unavailable' as const};
  await this.checkCatalogRun(run);
  if(!this.catalogRunCurrent(run,read.catalog.marker))return {status:'superseded'};
  if(saved.status==='stale' || saved.status==='superseded'){
   // A retired background pass has no further RAM acceptance work. Ordinary
   // callers retain their existing local reconciliation after a write race.
   if(!run.authority)await this.refreshLocal();return {status:'superseded'};
  }
  return this.publishCatalog(read,saved);
 }
 private publishCatalog(read:Exclude<LibraryCatalogRead,{status:'unstable'}>,saved:Awaited<ReturnType<AccountLibraryStore['putCatalog']>>):LibraryRefreshResult {
  const durable=saved.status==='stored';this.available=durable;
  if(saved.status==='stored')this.lease=saved.lease;
  const changed=!this.catalogComplete || this.catalog?.marker!==read.catalog.marker;
  this.applyCatalog(read.catalog);if(changed)this.announce({kind:'catalog',catalog:read.catalog,durable});
  return {status:read.status,durable};
 }
 private async refreshCatalog(run:CatalogRun):Promise<LibraryRefreshResult> {
  await this.checkCatalogRun(run);
  const base=await this.options.storage.readCatalog();await this.checkCatalogRun(run);
  if(base && base.lease.accountId!==run.access.accountId){await this.refreshLocal();throw failed('account_changed');}
  const client={catalog:(...args:Parameters<ChartClient['catalog']>)=>this.readCatalogStep(run,()=>this.options.client.catalog(...args)),
   confirmCatalog:(...args:Parameters<ChartClient['confirmCatalog']>)=>this.readCatalogStep(run,()=>this.options.client.confirmCatalog(...args))};
  const read=await readCompleteLibraryCatalog(client,run.access.accountId,base?.catalog??null,run.signal);await this.checkCatalogRun(run);
  if(read.status==='unstable')return read;
  if(!this.catalogRunCurrent(run,read.catalog.marker))return {status:'superseded'};
  return this.saveCatalog(base,read,run);
 }
 private async readCatalogStep<T>(run:CatalogRun,read:()=>Promise<T>) {
  await this.checkCatalogRun(run);const result=await read();await this.checkCatalogRun(run);return result;
 }
 private canJoinCatalog(run:CatalogRun,loading:CatalogRun) {
  if(loading.signal.aborted)return false;
  if(!run.authority || !loading.authority)return run.authority===loading.authority;
  const a=run.authority.permit,b=loading.authority.permit;
  return run.authority.signal===loading.authority.signal && (['key','token','owner','sessionId'] as const).every(key=>a[key]===b[key]);
 }
 private createCatalogRun(authority?:CheckAuthority):CatalogRun {
  const signal=authority?AbortSignal.any([this.controller.signal,authority.signal]):this.controller.signal;
  return {seen:this.generation,content:this.contentGeneration,access:{...this.current!},signal,
   authority:authority && {...authority,permit:{...authority.permit}}};
 }
 async load(authority?:CheckAuthority):Promise<LibraryRefreshResult> {
  if(!this.current || !this.options.online() || this.closed)return {status:'inactive'};
  const run=this.createCatalogRun(authority);
  const shared=this.loading;
  if(shared && this.canJoinCatalog(run,shared.run)){await this.checkCatalogRun(run);return shared.promise;}
  const loading={run,promise:this.refreshCatalog(run)};this.loading=loading;
  try{return await loading.promise;}finally{if(this.loading===loading)this.loading=null;}
 }
 async canRestore(chartId:string):Promise<boolean> {
      const seen=this.generation,target=this.lease,chart=this.records.find(value=>value.id===chartId);
      if(this.closed || !target || !chart || !this.isReady(chartId) || this.removals.pending.has(chartId))return false;
      const durable=await this.options.storage.canRestore(target,chart).catch(()=>false);
      return durable && !this.closed && this.generation===seen && this.lease===target
        && this.records.find(value=>value.id===chartId)===chart && !this.removals.pending.has(chartId);
    }
 async markOpened(chartId: string): Promise<void> {
      const chart=this.records.find(chart=>chart.id===chartId);
      if (this.closed || !this.lease || !chart) return;
      // The visible selection lifts priority and can place a RAM-only card.
      await this.options.storage.touch(this.lease, chartId, chart,this.minimumMarker).catch(() => false);
    }
 prepareAcceptance() {
      const seen=this.generation, target=this.lease, access=this.current && {...this.current};
      return async (chartId:string, chart?:AccountChart,marker?:string):Promise<AccountChart> => {
        if(this.closed || !access || !sameLibrarySession(this.current,access))
          throw failed('account_changed');
        // A deletion fences responses already in flight. A fresh address read may
        // establish current data; the captured projection cannot restore it.
        if(!chart || !isLibraryCatalogMarker(marker) || seen!==this.generation)return this.open(chartId);
        return this.acceptObservation(chart,seen,target,marker);
      };
    }
 private async acceptObservation(chart:AccountChart,seen:number,target:LibraryLease|null,marker:string):Promise<AccountChart> {
  if(this.older(marker))return this.currentRecord(chart);
  try{await this.accept(chart,seen,target,marker);}
  catch(error){if(codeOf(error)==='library_changed')return this.currentRecord(chart);throw error;}
  this.check(seen);return this.get(chart.id)!;
 }
 private currentRecord(observed:AccountChart):Promise<AccountChart> {
  const current=this.get(observed.id);
  if(current && current.revision>observed.revision && this.isReady(current.id))return Promise.resolve(current);
  return this.open(observed.id);
 }
 async clear() {
      let accountId = this.ownerId ?? this.current?.accountId ?? null;
      // Queue account-scoped deletion before observers may connect a new account.
      const clearing = accountId ? this.options.storage.clearAccount(accountId)
        : this.options.storage.read().then(snapshot => {
          accountId=snapshot?.lease?.accountId??null;
          return accountId ? this.options.storage.clearAccount(accountId) : snapshot ? 'cleared' as const : 'unavailable' as const;
        });
      this.invalidate(); const seen = this.generation;
      this.current=null;this.resetWorking(); this.emit();
      const status = await clearing;
      if (seen === this.generation) {this.available=status!=='unavailable';this.emit();}
      if(status==='cleared')this.options.notify({kind:'changed'});
      return {accountId,status};
    }
 async retryClear(accountId:string) {
      const seen=this.generation, status=await this.options.storage.clearAccount(accountId);
      if(seen===this.generation && !this.ownerId && !this.current){this.available=status!=='unavailable';this.emit();}
      if(status==='cleared')this.options.notify({kind:'changed'});
      return status;
    }
 private applyCatalog(incoming:LibraryCatalogSnapshot) {
  this.catalog=incoming;this.catalogComplete=true;this.advance(incoming.marker);
  const present=new Set(incoming.entries.map(row=>row.id));this.retainList(this.records.filter(row=>present.has(row.id)));this.emit();
 }
 private async readCatalogLease(seen:number) {
  const base=await this.options.storage.readCatalog();this.check(seen);
  if(base && base.lease.accountId!==this.ownerId)return false;
  if(base){this.advance(base.minimumMarker??'0');if(base.catalog)this.advance(base.catalog.marker);this.lease=base.lease;}
  return true;
 }
 private async receiveCatalog(notice:Extract<LibraryNotice,{kind:'catalog'}>) {
  if(this.older(notice.catalog.marker))return;
  if(notice.durable && !await this.readCatalogLease(this.generation))return;
  if(!this.older(notice.catalog.marker))this.applyCatalog(notice.catalog);
 }
 private async receiveRecord(notice:Extract<LibraryNotice,{kind:'record'}>) {
  if(this.older(notice.marker))return;
  const seen=this.generation;this.advance(notice.marker);this.contentGeneration++;
  if(notice.durable)await this.readLocal(()=>this.check(seen),notice.accountId,false,notice.entry.id);
  if(seen!==this.generation)return;
  if(!this.older(notice.marker))this.replaceEntry(notice.entry,notice.marker,notice.accountId);
  this.emit();
 }
 private replaceEntry(row:LibraryCatalogEntry,marker:string,accountId:string) {
  const rows=new Map(projectLibraryEntries(this.catalog,this.records,this.rows).map(entry=>[entry.id,entry]));
  const prior=rows.get(row.id);if(!prior || prior.revision<=row.revision)rows.set(row.id,row);
  this.catalog={accountId,marker,entries:[...rows.values()]};this.catalogComplete=false;
 }
 private removeWorking(chartId:string) {
  this.contentGeneration++;this.catalogComplete=false;
  if(this.catalog)this.catalog={...this.catalog,entries:this.catalog.entries.filter(row=>row.id!==chartId)};
  this.records=this.records.filter(chart=>chart.id!==chartId);
 }
 private async receiveRemoval(notice:Extract<LibraryNotice,{kind:'removed'}>) {
  if(this.older(notice.marker))return;
  this.advance(notice.marker);this.invalidate(true);this.removeWorking(notice.chartId);
  if(notice.durable)await this.readCatalogLease(this.generation);
  this.emit();
 }
 async receive(value:unknown) {
  if(this.closed)return;
  const notice=parseLibraryNotice(value,this.current);
  if(!notice || notice.kind!=='changed' && notice.accountId!==this.ownerId)return;
  switch(notice.kind) {
   case 'changed':return this.refreshLocal();
   case 'catalog':return this.receiveCatalog(notice);
   case 'record':return this.receiveRecord(notice);
   case 'removed':return this.receiveRemoval(notice);
  }
 }
 close() { this.closed = true; this.invalidate(); this.listeners.clear(); this.options.storage.close(); }
}
export function createAccountLibrary(options:Options){return new AccountLibraryOwner(options);}
export type AccountLibrary=ReturnType<typeof createAccountLibrary>;
