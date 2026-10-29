import {createHmac,timingSafeEqual} from 'node:crypto';
import {normalizeMainReturn,type ReturnAction} from '../../shared/chart-return-contract.ts';
import type {CycleInput,CycleResult} from '../../shared/cycles-format.ts';

const invalid=()=>new TypeError('Invalid return receipt');
/** Issued only for trusted cycles output. Proves numbers and input, never identity or access. */
export function createReturnReceipts({key}:{key:Uint8Array}) {
  if(key.byteLength!==32)throw invalid();
  const secret=Buffer.from(key);
  const signature=(action:ReturnAction,prepared:NonNullable<ReturnType<typeof normalizeMainReturn>>,historicalPrefix?:string)=>
    createHmac('sha256',secret).update('forma:return-receipt:v1\0')
      .update(JSON.stringify([...(historicalPrefix?[historicalPrefix]:[]),action,prepared.input,prepared.result])).digest();
  return {
    issue(action:ReturnAction,input:CycleInput,result:unknown):string|undefined {
      const prepared=normalizeMainReturn(action,input,result);
      return prepared?`v1.${signature(action,prepared).toString('base64url')}`:undefined;
    },
    read(action:ReturnAction,input:CycleInput,result:unknown,proof:unknown):CycleResult {
      if(typeof proof!=='string')throw invalid();
      // Historical receipts signed their prefix too. It is authenticated input,
      // never a current version, a readiness check or a reason to recalculate.
      // This fixed shape also bounds the whole proof and its 32-byte signature.
      const parts=/^v1\.(?:([a-f0-9]{64})\.)?([A-Za-z0-9_-]{43})$/.exec(proof);
      if(!parts)throw invalid();
      const actual=Buffer.from(parts[2]!,'base64url');
      if(actual.toString('base64url')!==parts[2])throw invalid();
      const prepared=normalizeMainReturn(action,input,result);
      if(!prepared)throw invalid();
      if(!timingSafeEqual(actual,signature(action,prepared,parts[1])))throw invalid();
      return prepared.result;
    },
  };
}
