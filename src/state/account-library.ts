import type { AccountChart } from '../../shared/chart-record-contract.ts';
import type { ChartClient } from '../data/chart-client.ts';
import type { AccountLibraryStore, LibraryLease } from '../data/account-library-store.ts';

export interface LibrarySession { accountId: string; sessionId: string }
interface Options {
  client: Pick<ChartClient, 'list' | 'own'>; storage: AccountLibraryStore; calculationVersion: string;
  online: () => boolean; restoreAllowed?: () => Promise<boolean>; notify?: () => void;
}
const failed = (code: string) => Object.assign(new Error(code), {code});
const codeOf = (error: unknown) => (error as {code?: string} | null)?.code;

/** One working account library. Acquisition and persistence never choose the visible chart. */
export function createAccountLibrary({client, storage, calculationVersion, online, restoreAllowed = async () => true, notify = () => {}}: Options) {
  let charts: AccountChart[] = [], ownerId: string | null = null, current: LibrarySession | null = null;
  let lease: LibraryLease | null = null, generation = 0, available = true, closed = false;
  let backgroundStopped = false;
  let version = calculationVersion, controller = new AbortController(), loading: Promise<void> | null = null;
  let removals = {pending: new Map<string, Promise<void>>(), tail: Promise.resolve()};
  const listeners = new Set<() => void>();
  const observable = () => [charts, ownerId, available, version, current?.accountId, current?.sessionId, lease?.generation];
  let published = observable();
  const emit = (durableChanged = false) => {
    const next = observable();
    if (!durableChanged && next.every((value, index) => value === published[index])) return;
    published = next;
    for (const listener of listeners) listener();
  };
  function retainList(next: AccountChart[]) {
    if (next.length !== charts.length || next.some((chart, index) => chart !== charts[index])) charts = next;
  }
  function invalidate(keepRemovals = false) {
    generation++; controller.abort(); controller = new AbortController(); loading = null;
    if (!keepRemovals) removals = {pending: new Map(), tail: Promise.resolve()};
  }
  function check(seen: number) { if (closed || seen !== generation) throw failed('account_changed'); }
  async function readLocal(valid: () => void, accountId = current?.accountId) {
    const snapshot = await storage.read(); valid();
    if (!snapshot) { available = false; emit(); return false; }
    available = true;
    if (accountId && snapshot.lease?.accountId !== accountId) {
      invalidate(); lease = null; ownerId = null; charts = []; emit(); return false;
    }
    const previous = new Map(charts.map(chart => [chart.id, chart]));
    const sameGeneration = lease?.generation === snapshot.lease?.generation && lease?.accountId === snapshot.lease?.accountId;
    const next = new Map(snapshot.charts.filter(chart => !removals.pending.has(chart.id)).map(chart => {
      const prior = previous.get(chart.id);
      return [chart.id, prior?.accountId === chart.accountId && (prior.revision > chart.revision
        || prior.revision === chart.revision && prior.noteRevision === chart.noteRevision
          && prior.publicRevision === chart.publicRevision && prior.calculationVersion === chart.calculationVersion) ? prior : chart] as const;
    }));
    if (sameGeneration) for (const chart of charts) if (!next.has(chart.id) && !removals.pending.has(chart.id)) next.set(chart.id, chart);
    lease = snapshot.lease; ownerId = lease?.accountId ?? null; retainList([...next.values()]); emit(); return true;
  }
  async function refreshLocal() {
    const seen = generation; await readLocal(() => check(seen));
  }
  async function accept(values: readonly AccountChart[], seen: number, expectedLease: LibraryLease | null) {
    check(seen);
    if (values.some(chart => chart.accountId !== ownerId)) throw failed('account_changed');
    let durableChanged = false;
    if (expectedLease) {
      const result = await storage.put(expectedLease, values); check(seen);
      if (result.status === 'stale') { await refreshLocal(); throw failed('account_changed'); }
      durableChanged = (result.status === 'stored' || result.status === 'partial') && result.changed !== false;
      available = result.status === 'stored';
      if (result.status === 'partial' || result.status === 'stored' && result.pressure) backgroundStopped = true;
    }
    const next = new Map(charts.map(chart => [chart.id, chart]));
    for (const chart of values) {
      if (!next.has(chart.id) || next.get(chart.id)!.revision < chart.revision) next.set(chart.id, chart);
    }
    retainList([...next.values()]); emit(durableChanged);
    if (durableChanged) notify();
  }
  function forget(chartId: string): Promise<void> {
    const scope = removals, accountId = ownerId, pending = scope.pending.get(chartId);
    if (pending) return pending;
    if (!accountId) return Promise.resolve();
    // Fence old reads immediately, while other confirmed deletions keep their
    // own work. Only account/session changes revoke this deletion scope.
    invalidate(true);
    const valid = () => {
      if (closed || scope !== removals || ownerId !== accountId) throw failed('account_changed');
    };
    const work = scope.tail.then(async () => {
      valid();
      while (lease) {
        const result = await storage.remove(lease, chartId); valid();
        if (result.status === 'stored') { lease = result.lease; break; }
        if (result.status === 'unavailable') { available = false; lease = null; break; }
        // Another deletion advanced the lease. Re-read the same account and
        // retry this exact confirmed target; never acquire another account.
        const refreshed = await readLocal(valid, accountId); valid();
        if (!refreshed) { lease = null; break; }
      }
      notify();
    }).finally(() => { scope.pending.delete(chartId); });
    scope.pending.set(chartId, work);
    scope.tail = work.catch(() => {});
    charts = charts.filter(chart => chart.id !== chartId); emit();
    return work;
  }
  return {
    get charts(): readonly AccountChart[] { return charts; },
    get accountId() { return ownerId; },
    get session() { return current; },
    get storageAvailable() { return available; },
    get calculationVersion() { return version; },
    subscribe(listener: () => void) { listeners.add(listener); listener(); return () => { listeners.delete(listener); }; },
    get: (id: string) => charts.find(chart => chart.id === id),
    async restore() {
      const seen = generation;
      if (!await restoreAllowed()) { check(seen); return; }
      check(seen); await refreshLocal();
    },
    async connect(value: LibrarySession | null) {
      if (current?.accountId === value?.accountId && current?.sessionId === value?.sessionId) return;
      invalidate(); const seen = generation;
      current = value ? {...value} : null;
      if (!value) { emit(); return; } // Expiry is not an explicit logout.
      if (ownerId !== value.accountId) { charts = []; ownerId = value.accountId; lease = null; emit(); }
      const result = await storage.activate(value.accountId); check(seen);
      available = result.status === 'stored';
      lease = result.status === 'stored' ? result.lease : null;
      if (lease) await refreshLocal();
      else emit();
    },
    async load() {
      if (!current || !online() || closed || backgroundStopped) return;
      if (loading) return loading;
      const seen = generation, access = {...current}, signal = controller.signal, target = lease;
      const run = (async () => {
        let after: string | undefined;
        do {
          check(seen);
          const page = await client.list({expectedAccountId: access.accountId, ...(after ? {after} : {})}, signal);
          check(seen); version = page.calculationVersion;
          await accept(page.charts, seen, target);
          if (backgroundStopped || !available) { backgroundStopped = true; return; } // Retry background storage only after the next opening.
          after = page.nextCursor ?? undefined;
        } while (after);
      })();
      loading = run;
      try { await run; } finally { if (loading === run) loading = null; }
    },
    async canRestore(chartId:string):Promise<boolean> {
      const seen=generation,target=lease,chart=charts.find(value=>value.id===chartId);
      if(closed || !target || !chart || chart.calculationVersion!==version || removals.pending.has(chartId))return false;
      const durable=await storage.canRestore(target,chart).catch(()=>false);
      return durable && !closed && generation===seen && lease===target && chart.calculationVersion===version
        && charts.find(value=>value.id===chartId)===chart && !removals.pending.has(chartId);
    },
    async markOpened(chartId: string): Promise<void> {
      if (closed || !lease || !charts.some(chart => chart.id === chartId)) return;
      // The visible selection calls this; background acquisition never counts as use.
      await storage.touch(lease, chartId).catch(() => false);
    },
    async open(chartId: string, consumerSignal?: AbortSignal): Promise<AccountChart> {
      consumerSignal?.throwIfAborted();
      const cached = charts.find(chart => chart.id === chartId);
      if (!online() || !current) {
        if (cached?.calculationVersion === version) return cached;
        throw failed(online() ? 'auth_required' : 'offline');
      }
      const seen = generation, target = lease;
      const signal = consumerSignal ? AbortSignal.any([controller.signal, consumerSignal]) : controller.signal;
      const valid = () => { check(seen); signal.throwIfAborted(); };
      try {
        const chart = await client.own({chartId, expectedAccountId: current.accountId}, signal);
        valid(); await accept([chart], seen, target); valid(); return charts.find(value => value.id === chartId)!;
      } catch (error) {
        valid();
        if (codeOf(error) === 'not_found') await forget(chartId);
        else if (['offline','connection_failed','server_unavailable'].includes(codeOf(error) ?? '') && cached?.calculationVersion === version) return cached;
        throw error;
      }
    },
    forget,
    async clear() {
      let accountId = ownerId ?? current?.accountId ?? null;
      // Queue account-scoped deletion before observers may connect a new account.
      const clearing = accountId ? storage.clearAccount(accountId)
        : storage.read().then(snapshot => {
          accountId=snapshot?.lease?.accountId??null;
          return accountId ? storage.clearAccount(accountId) : snapshot ? 'cleared' as const : 'unavailable' as const;
        });
      invalidate(); const seen = generation;
      current = null; ownerId = null; lease = null; charts = []; emit();
      const status = await clearing;
      if (seen === generation) {available=status!=='unavailable';emit();}
      if(status==='cleared')notify();
      return {accountId,status};
    },
    async retryClear(accountId:string) {
      const seen=generation, status=await storage.clearAccount(accountId);
      if(seen===generation && !ownerId && !current){available=status!=='unavailable';emit();}
      if(status==='cleared')notify();
      return status;
    },
    refreshLocal,
    close() { closed = true; invalidate(); listeners.clear(); storage.close(); },
  };
}
export type AccountLibrary = ReturnType<typeof createAccountLibrary>;
