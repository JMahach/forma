import { parentPort, workerData } from 'node:worker_threads';
import { openJournalStore } from './store.ts';
import { parseJournalEvent } from './events.ts';
import type { JournalWorkerData, JournalWorkerReply, JournalWorkerRequest } from './policy.ts';

const port=parentPort;
if(!port)throw new Error('The journal worker requires a parent');
const config=workerData as JournalWorkerData;
let store:ReturnType<typeof openJournalStore>|undefined;
const reply=(message:JournalWorkerReply)=>port.postMessage(message);
function fail() {try{store?.close();}finally{reply({kind:'failed'});port!.close();}}
try {
  store=openJournalStore(config);
  const initial=store.maintain(config.now,config.externalReservedBytes);
  reply({kind:'ready',usage:store.usage(),more:initial.more});
  port.on('message',(message:JournalWorkerRequest)=>{
    try {
      if(message.kind==='maintain') {
        const result=store!.maintain(message.now,message.externalReservedBytes);
        reply({kind:'maintained',usage:store!.usage(),more:result.more});return;
      }
      const total=message.entries.reduce((sum,entry)=>sum+entry.bytes.byteLength,0);
      if(total>config.policy.maxBatchBytes || message.entries.length>config.policy.maxPendingCount)throw new Error('Journal batch exceeds its bounds');
      const results=message.entries.map(entry=>{
        const value=entry.bytes.byteLength<=config.policy.maxEventBytes
          ?parseJournalEvent(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(entry.bytes))):null;
        return {id:entry.id,result:value?store!.append(value,message.now,message.externalReservedBytes)
          :{status:'invalid' as const,reason:'invalid_event'}};
      });
      reply({kind:'batch',results,usage:store!.usage()});
      if(results.some(entry=>entry.result.status==='retryable' && entry.result.reason==='journal_unavailable'))fail();
    } catch {fail();}
  });
} catch {fail();}
