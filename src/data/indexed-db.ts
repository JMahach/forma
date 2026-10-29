export type IndexedResult<T> = {status:'complete';value:T|null}|{status:'quota'|'unavailable'};
type OpenResult = {status:'complete';value:IDBDatabase}|{status:'quota'|'unavailable'};
type TransactionAction<T>=(tx:IDBTransaction,result:(value:T)=>void,fail:(cause?:unknown)=>void)=>void;
const storageFailure=(cause:unknown):'quota'|'unavailable'=>(cause as {name?:string}|null)?.name==='QuotaExceededError'?'quota':'unavailable';
interface IndexedDatabaseOptions {
  databaseName: string;
  version: number;
  stores: string[];
  upgrade: (database: IDBDatabase, transaction: IDBTransaction, oldVersion: number) => void;
  indexedDB?: IDBFactory | null;
  timeoutMs?: number;
}

// Connection and transaction lifetime for optional browser storage. Each
// repository owns its schema and retention rules; storage failure is a miss.
export function createIndexedDatabase({ databaseName, version, stores, upgrade,
  indexedDB: factory, timeoutMs = 1000 }: IndexedDatabaseOptions) {
  let database: IDBDatabase | null = null, opening: Promise<OpenResult> | null = null, closed = false;
  function open(): Promise<OpenResult> {
    if (closed) return Promise.resolve({status:'unavailable'});
    if (database) return Promise.resolve({status:'complete',value:database});
    if (opening) return opening;
    let request: IDBOpenDBRequest;
    try {
      const indexedDB = factory === undefined ? globalThis.indexedDB : factory;
      if (!indexedDB) return Promise.resolve({status:'unavailable'});
      request = indexedDB.open(databaseName, version);
    } catch (cause) { return Promise.resolve({status:storageFailure(cause)}); }
    opening = new Promise<OpenResult>(resolve => {
      let done = false, failure:'quota'|'unavailable'|undefined;
      const finish = (value: OpenResult) => { if (!done) { done = true; clearTimeout(timer); resolve(value); } };
      const timer = setTimeout(() => finish({status:'unavailable'}), timeoutMs);
      request.onupgradeneeded = event => {
        if (done || closed) { request.transaction!.abort(); return; }
        try { upgrade(request.result, request.transaction!, event.oldVersion); }
        catch (cause) {
          failure=storageFailure(cause);
          // Preserve the cause, but wait for rollback before allowing a retry.
          request.transaction!.abort();
        }
      };
      request.onsuccess = () => {
        opening = null;
        const db = request.result;
        if (done || closed) { db.close(); return; }
        database = db;
        const forget = () => { if (database === db) database = null; };
        db.onclose = forget;
        db.onversionchange = () => { db.close(); forget(); };
        finish({status:'complete',value:db});
      };
      request.onerror = () => { opening = null; finish({status:failure??storageFailure(request.error)}); };
      // The browser cannot cancel open(). Keep a settled miss until its native
      // request ends, so retries cannot accumulate blocked connections.
      request.onblocked = () => finish({status:'unavailable'});
    });
    return opening;
  }
  async function transactionResult<T>(mode:IDBTransactionMode,action:TransactionAction<T>):Promise<IndexedResult<T>> {
    const opened=await open();if(closed)return {status:'unavailable'};
    if(opened.status!=='complete')return opened;
    const db=opened.value;
    return new Promise(resolve=>{
      let tx:IDBTransaction|undefined,value:T|null=null,done=false,failure:'quota'|'unavailable'|undefined;
      const finish=(result:IndexedResult<T>)=>{if(done)return;done=true;clearTimeout(timer);resolve(result);};
      const fail=(cause?:unknown)=>{
        if(failure!=='quota')failure=storageFailure(cause);
        // Retrying before abort finishes could race the original transaction.
        try{if(tx)tx.abort();else finish({status:failure});}catch{finish({status:failure});}
      };
      const timer=setTimeout(()=>fail(),timeoutMs);
      try{
        tx=db.transaction(stores,mode);
        tx.oncomplete=()=>finish({status:'complete',value});
        tx.onerror=event=>{if(failure!=='quota')failure=storageFailure((event.target as IDBRequest|null)?.error??tx?.error);};
        tx.onabort=()=>finish({status:failure??storageFailure(tx?.error)});
        action(tx,result=>{value=result;},fail);
      }catch(cause){fail(cause);}
    });
  }
  return {
    transactionResult,
    async transaction<T=unknown>(mode:IDBTransactionMode,action:TransactionAction<T>):Promise<T|null> {
      const result=await transactionResult(mode,action);return result.status==='complete'?result.value:null;
    },
    close() { closed = true; database?.close(); database = null; },
  };
}
