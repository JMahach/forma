import {TransactionPlacement,replaceAfterQuota,type PlacementProgress} from './library-package-placement.ts';
import {unlinkLibraryPackages,linkLibraryPackages} from './library-package-store.ts';
import {markLibraryMutation} from './library-catalog-store.ts';
import type { AccountChart } from '../../shared/chart-record-contract.ts';
import { validateAccountChart } from '../domain/account-chart.ts';
import type { createIndexedDatabase } from './indexed-db.ts';
import type { StoragePressure } from './storage-pressure.ts';

interface Placement {
  database:Pick<ReturnType<typeof createIndexedDatabase>,'transactionResult'>;
  isOwner:(owner:unknown)=>boolean;isCurrent:()=>boolean;chart:AccountChart;openedAt?:number;pressure?:StoragePressure;marker?:string;
}
function needsReplacement(value:unknown,chart:AccountChart) {
  try{return validateAccountChart(value,chart.accountId).revision<chart.revision;}catch{return true;}
}
function replaceWithinTransaction(tx:IDBTransaction,input:Placement,limit:number,
  state:{needsPayload:boolean},owner:Record<string,unknown>,done:(value:boolean)=>void,fail:(cause?:unknown)=>void,progress?:PlacementProgress) {
  const {chart,openedAt,isCurrent}=input,rows=tx.objectStore('charts'),usage=tx.objectStore('usage');
  const placement=new TransactionPlacement(tx,{id:chart.id,kind:'card',chartIds:[chart.id],openedAt},
    state.needsPayload?limit:0,isCurrent,fail,progress);
  const saveUse=()=>openedAt===undefined?done(true):placement.write(()=>usage.put({id:chart.id,openedAt}),()=>done(true));
  const saveCard=()=>placement.write(()=>rows.put(chart),()=>{
    try{unlinkLibraryPackages(tx,chart.id,chart);linkLibraryPackages(tx,chart);markLibraryMutation(tx,owner,input.marker);saveUse();}catch(error){fail(error);}
  });
  placement.start(state.needsPayload?saveCard:saveUse);
}
function placementAttempt(input:Placement,limit:number,progress?:PlacementProgress) {
  const {database,isOwner,chart,isCurrent}=input,state={needsPayload:true};
  const write=()=>database.transactionResult<boolean>('readwrite',(tx,done,fail)=>{
    const owner=tx.objectStore('context').get('owner');owner.onsuccess=()=>{
      if(!isOwner(owner.result) || !isCurrent()){done(false);return;}
      const prior=tx.objectStore('charts').get(chart.id);prior.onsuccess=()=>{
        state.needsPayload=needsReplacement(prior.result,chart);
        replaceWithinTransaction(tx,input,limit,state,owner.result,value=>{
          if(progress)progress.ready=true;done(value);
        },fail,progress);
      };
    };
  });
  return {state,write};
}

/** Release disposable service data first, then replace lower-priority payloads atomically. */
export async function placeOpenedCard(input:Placement):Promise<boolean> {
  if(!input.isCurrent())return false;
  const first=placementAttempt(input,0);
  const result=input.pressure?await input.pressure.write(first.write,{atomicLibrary:true}):await first.write();
  if(result.status==='complete')return result.value===true;
  if(result.status!=='quota' || !first.state.needsPayload || !input.isCurrent())return false;
  return (await replaceCardAfterQuota(input)).saved;
}

/** Caller has already tried the normal write and permitted service relief. */
export async function replaceCardAfterQuota(input:Placement) {
  if(!input.isCurrent())return {saved:false,changed:false};
  let changed=false;
  const result=await replaceAfterQuota(async(limit,progress)=>{
    const attempt=placementAttempt(input,limit,progress),result=await attempt.write();
    changed=attempt.state.needsPayload;return result;
  });
  const saved=result.status==='complete' && result.value===true;
  return {saved,changed:saved && changed};
}
