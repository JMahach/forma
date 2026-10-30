import type {TestContext} from 'node:test';
import {IDBObjectStore,IDBTransaction} from 'fake-indexeddb';

// fake-indexeddb has no quota. Inject it at its final commit step, after all
// requests succeeded, so the real adapter must observe abort and rollback.
type PendingTransaction = IDBTransaction & {
  _start():void; _abort(name:string):void; _state:string;
  _requests:{request:IDBRequest}[];
};
export function commitQuota(t:TestContext,incoming:{store:string;id:string},requiredVictims:number) {
  const states=new WeakMap<IDBTransaction,{incoming:boolean;deleted:string[]}>();
  const attempts:string[][]=[];
  const state=(tx:IDBTransaction)=>{
    let value=states.get(tx);if(!value){value={incoming:false,deleted:[]};states.set(tx,value);}return value;
  };
  const put=IDBObjectStore.prototype.put,remove=IDBObjectStore.prototype.delete;
  t.mock.method(IDBObjectStore.prototype,'put',function(this:IDBObjectStore,...args:Parameters<typeof put>){
    if(this.name===incoming.store && args[0]?.id===incoming.id)state(this.transaction).incoming=true;
    return put.apply(this,args);
  });
  t.mock.method(IDBObjectStore.prototype,'delete',function(this:IDBObjectStore,...args:Parameters<typeof remove>){
    if(this.name==='charts'||this.name==='packages')state(this.transaction).deleted.push(String(args[0]));
    return remove.apply(this,args);
  });
  const prototype=IDBTransaction.prototype as PendingTransaction,start=prototype._start;
  t.mock.method(prototype,'_start',function(this:PendingTransaction){
    const current=states.get(this);
    if(current?.incoming && this._state!=='finished' && !this._requests.some(row=>row.request.readyState!=='done')) {
      attempts.push([...current.deleted]);
      if(current.deleted.length<requiredVictims){this._abort('QuotaExceededError');return;}
    }
    start.call(this);
  });
  return attempts;
}
