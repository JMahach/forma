import {createHmac,timingSafeEqual} from 'node:crypto';
import {normalizeMainReturn,MAX_RETURN_PROOF_LENGTH,type ReturnAction} from '../../shared/chart-return-contract.ts';
import type {CycleInput,CycleResult} from '../../shared/cycles-format.ts';

const invalid=()=>new TypeError('Invalid return receipt');
/** Issued only for trusted cycles output. Proves numbers and input, never identity or access. */
export function createReturnReceipts({key,cyclesVersion}:{key:Uint8Array;cyclesVersion:string}) {
  if(key.byteLength!==32 || !/^[a-f0-9]{64}$/.test(cyclesVersion))throw invalid();
  const secret=Buffer.from(key);
  const signature=(action:ReturnAction,prepared:NonNullable<ReturnType<typeof normalizeMainReturn>>)=>
    createHmac('sha256',secret).update('forma:return-receipt:v1\0')
      .update(JSON.stringify([cyclesVersion,action,prepared.input,prepared.result])).digest();
  return {
    issue(action:ReturnAction,input:CycleInput,result:unknown):string|undefined {
      const prepared=normalizeMainReturn(action,input,result);
      return prepared?`v1.${cyclesVersion}.${signature(action,prepared).toString('base64url')}`:undefined;
    },
    read(action:ReturnAction,input:CycleInput,result:unknown,proof:unknown):CycleResult|null {
      if(typeof proof!=='string' || proof.length>MAX_RETURN_PROOF_LENGTH)throw invalid();
      const parts=/^v1\.([a-f0-9]{64})\.([A-Za-z0-9_-]{43})$/.exec(proof);
      if(!parts)throw invalid();
      if(parts[1]!==cyclesVersion)return null;
      const prepared=normalizeMainReturn(action,input,result);
      if(!prepared)throw invalid();
      const expected=signature(action,prepared),actual=Buffer.from(parts[2]!,'base64url');
      if(actual.length!==expected.length || actual.toString('base64url')!==parts[2] || !timingSafeEqual(actual,expected))throw invalid();
      return prepared.result;
    },
  };
}
