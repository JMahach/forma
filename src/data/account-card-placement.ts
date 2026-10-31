import type {ChangedLibraryKeys} from './library-local-changes.ts';
import {LibrarySpaceRelease,releaseLibrarySpace,restoreCardUsage,type PlacementProgress} from './library-package-placement.ts';
import {unlinkLibraryPackages,linkLibraryPackages} from './library-package-store.ts';
import {markLibraryMutation} from './library-catalog-store.ts';
import type { AccountChart } from '../../shared/chart-record-contract.ts';
import { validateAccountChart } from '../domain/account-chart.ts';
import type { createIndexedDatabase } from './indexed-db.ts';
import type { StoragePressure } from './storage-pressure.ts';

interface Placement {
  database:Pick<ReturnType<typeof createIndexedDatabase>,'transactionResult'>;
  isOwner:(owner:unknown)=>boolean;isCurrent:()=>boolean;chart:AccountChart;openedAt?:number;pressure:StoragePressure;marker?:string;changed?:ChangedLibraryKeys;
}
function needsReplacement(value:unknown,chart:AccountChart) {
  try{return validateAccountChart(value,chart.accountId).revision<chart.revision;}catch{return true;}
}
function replaceWithinTransaction(tx:IDBTransaction,input:Placement,
  state:{needsPayload:boolean},owner:Record<string,unknown>,done:(value:boolean)=>void,fail:(cause?:unknown)=>void,progress?:PlacementProgress) {
  const {chart,openedAt,isCurrent}=input,rows=tx.objectStore('charts'),usage=tx.objectStore('usage');
  if(progress){
    if(!state.needsPayload){done(false);return;}
    new LibrarySpaceRelease(tx,{id:chart.id,kind:'card',chartIds:[chart.id],openedAt},
      isCurrent,fail,progress,input.changed).start(()=>done(true));return;
  }
  try {
    if(state.needsPayload){rows.put(chart);unlinkLibraryPackages(tx,chart.id,chart);linkLibraryPackages(tx,chart);
      if(openedAt===undefined)restoreCardUsage(tx,chart.id);markLibraryMutation(tx,owner,input.marker);}
    if(openedAt!==undefined)usage.put({id:chart.id,openedAt});
    done(true);
  }catch(error){fail(error);}
}
function placementAttempt(input:Placement,progress?:PlacementProgress) {
  const {database,isOwner,chart,isCurrent}=input,state={needsPayload:true};
  const write=()=>database.transactionResult<boolean>('readwrite',(tx,done,fail)=>{
    const owner=tx.objectStore('context').get('owner');owner.onsuccess=()=>{
      if(!isOwner(owner.result) || !isCurrent()){done(false);return;}
      const prior=tx.objectStore('charts').get(chart.id);prior.onsuccess=()=>{
        state.needsPayload=needsReplacement(prior.result,chart);
        replaceWithinTransaction(tx,input,state,owner.result,done,fail,progress);
      };
    };
  });
  return {state,write};
}

/** Release service data first, then lower-priority copies before a whole new write. */
export async function placeOpenedCard(input:Placement):Promise<boolean> {
  if(!input.isCurrent())return false;
  const first=placementAttempt(input);
  const result=await input.pressure.write(async()=>{
    const result=await first.write();
    // A failed optional use mark is not a missing payload to recover.
    return result.status==='quota' && !first.state.needsPayload?{status:'unavailable'}:result;
  },{accountLibrary:true},()=>releaseCardForSpace(input));
  return result.status==='complete' && result.value===true;
}

export async function releaseCardForSpace(input:Placement) {
  if(!input.isCurrent())return 'unavailable' as const;
  return releaseLibrarySpace(progress=>placementAttempt(input,progress).write());
}
