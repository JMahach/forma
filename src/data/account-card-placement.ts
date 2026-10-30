import type { AccountChart } from '../../shared/chart-record-contract.ts';
import { validateAccountChart } from '../domain/account-chart.ts';
import type { createIndexedDatabase } from './indexed-db.ts';
import type { StoragePressure } from './storage-pressure.ts';

interface Placement {
  database:Pick<ReturnType<typeof createIndexedDatabase>,'transactionResult'>;
  isOwner:(owner:unknown)=>boolean;isCurrent:()=>boolean;chart:AccountChart;openedAt:number;pressure?:StoragePressure;
}
function candidates(keys:IDBValidKey[],marks:{id:string;openedAt:number}[],chart:AccountChart,openedAt:number) {
  const used=new Map(marks.map(row=>[row.id,Number.isFinite(row.openedAt)?row.openedAt:0]));
  return keys.filter(key=>{
    const at=used.get(String(key))??0;
    return key!==chart.id && (at<openedAt || at===openedAt && String(key)<chart.id);
  }).sort((a,b)=>(used.get(String(a))??0)-(used.get(String(b))??0) || String(a).localeCompare(String(b)));
}
function needsReplacement(value:unknown,chart:AccountChart) {
  try{return validateAccountChart(value,chart.accountId).revision<chart.revision;}catch{return true;}
}
function writeRequest(write:()=>IDBRequest,accepted:()=>void,quota:()=>void,fail:(cause?:unknown)=>void) {
  const rejected=(cause:unknown)=>{
    if((cause as DOMException)?.name==='QuotaExceededError')quota();else fail(cause);
  };
  try {
    const request=write();request.onsuccess=accepted;
    request.onerror=event=>{event.preventDefault();event.stopPropagation();rejected(request.error);};
  }catch(error){rejected(error);}
}
function replaceWithinTransaction(tx:IDBTransaction,input:Placement,firstVictim:boolean,
  state:{needsPayload:boolean},done:(value:boolean)=>void,fail:(cause?:unknown)=>void) {
  const {chart,openedAt,isCurrent}=input,rows=tx.objectStore('charts'),usage=tx.objectStore('usage');
  let victims:IDBValidKey[]|undefined,next=0;
  const noSpace=()=>fail(new DOMException('No admissible local replacement','QuotaExceededError'));
  const releaseFor=(retry:()=>void)=>{
    if(!isCurrent()){fail();return;}
    if(!firstVictim){noSpace();return;}
    if(!victims) {
      const keys=rows.getAllKeys(),marks=usage.getAll();marks.onsuccess=()=>{
        victims=candidates(keys.result,marks.result,chart,openedAt);releaseFor(retry);
      };
      return;
    }
    if(next===victims.length){noSpace();return;}
    const remove=rows.delete(victims[next++]);remove.onsuccess=retry;
  };
  const saveUse=()=>writeRequest(()=>usage.put({id:chart.id,openedAt}),()=>done(true),
    ()=>state.needsPayload?releaseFor(saveUse):noSpace(),fail);
  const saveCard=()=>writeRequest(()=>rows.put(chart),saveUse,()=>releaseFor(saveCard),fail);
  if(!state.needsPayload){saveUse();return;}
  if(firstVictim)releaseFor(saveCard);else saveCard();
}
function placementAttempt(input:Placement,firstVictim:boolean) {
  const {database,isOwner,chart,isCurrent}=input,state={needsPayload:true};
  const write=()=>database.transactionResult<boolean>('readwrite',(tx,done,fail)=>{
    const owner=tx.objectStore('context').get('owner');owner.onsuccess=()=>{
      if(!isOwner(owner.result) || !isCurrent()){done(false);return;}
      const prior=tx.objectStore('charts').get(chart.id);prior.onsuccess=()=>{
        state.needsPayload=needsReplacement(prior.result,chart);
        replaceWithinTransaction(tx,input,firstVictim,state,done,fail);
      };
    };
  });
  return {state,write};
}

/** Release disposable service data first, then attempt atomic replacement once.
 * Request-time quota visits each victim once; commit-time quota stops with old data intact. */
export async function placeOpenedCard(input:Placement):Promise<boolean> {
  if(!input.isCurrent())return false;
  const first=placementAttempt(input,false);
  const result=input.pressure?await input.pressure.write(first.write,{atomicLibrary:true}):await first.write();
  if(result.status==='complete')return result.value===true;
  if(result.status!=='quota' || !first.state.needsPayload || !input.isCurrent())return false;
  const second=await placementAttempt(input,true).write();
  return second.status==='complete' && second.value===true;
}
