import { createHmac, timingSafeEqual } from 'node:crypto';
import { validChartCalculationResult } from '../../shared/calculation-result.ts';
import { MAX_CALCULATION_RECEIPT_LENGTH } from '../../shared/chart-record-contract.ts';
import type { CalculationRequest, ChartRecord } from '../../shared/chart-types.ts';
import type { Calculator } from './calculate.ts';

type Result=Awaited<ReturnType<Calculator>>;
const invalid=()=>new TypeError('Invalid calculation receipt');
function ambiguous(result:unknown):boolean {
  return !!(result && typeof result==='object' && 'timeResolution' in result
    && (result.timeResolution as {ambiguous?:unknown})?.ambiguous===true);
}
function binding(request:CalculationRequest,result:unknown):string {
  return JSON.stringify(request.mode==='transit'?['transit',request.utc]
    :['natal',request.date,request.time,String(request.city?.id),request.city?.timezone,ambiguous(result)?request.fold??null:null]);
}
function readSignedPayload(receipt:unknown,signature:(payload:string)=>Buffer) {
  if(typeof receipt!=='string' || receipt.length>MAX_CALCULATION_RECEIPT_LENGTH)throw invalid();
  const parts=/^([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{43})$/.exec(receipt);if(!parts)throw invalid();
  const expected=signature(parts[1]!),actual=Buffer.from(parts[2]!,'base64url');
  if(actual.length!==expected.length || actual.toString('base64url')!==parts[2] || !timingSafeEqual(actual,expected))throw invalid();
  return JSON.parse(Buffer.from(parts[1]!,'base64url').toString('utf8'));
}
/** Proof of already computed public numbers, never identity or permission to save.
 * The browser holds it with the temporary chart. No results are cached on the server. */
export function createCalculationReceipts({key}:{key:Uint8Array}) {
  if(key.byteLength!==32)throw new TypeError('Invalid receipt configuration');
  const secret=Buffer.from(key);
  const signature=(payload:string)=>createHmac('sha256',secret).update('forma:calculation-receipt:v1\0').update(payload).digest();
  return {
    issue(request:CalculationRequest,result:unknown):string|undefined {
      if(![undefined,'natal','transit'].includes(request.mode) || !validChartCalculationResult(result))return;
      const source=result as {chart:ChartRecord;timeResolution?:{ambiguous:boolean}};
      const chart=source.chart;
      const fields=['source','birthDate','birthTime','birthPlace','utc','timezone','utcOffset','fold',
        'designUtc','designArcResidualDegrees','personality','design','engine','ephemeris',
        'timezoneDatabase','nodeModel','zodiac','verification'] as const;
      const side=(entries:NonNullable<ChartRecord['activations']>['personality'])=>
        entries.map(({planet,longitude,gate,line})=>({planet,longitude,gate,line}));
      const prepared={chart:{...Object.fromEntries(fields.map(field=>[field,chart[field]])),
        activations:{personality:side(chart.activations!.personality),design:side(chart.activations!.design)},
        id:null,name:'',note:'',createdAt:'',updatedAt:''},timeResolution:source.timeResolution};
      const payload=Buffer.from(JSON.stringify({schema:1,binding:binding(request,prepared),result:prepared})).toString('base64url');
      const receipt=payload+'.'+signature(payload).toString('base64url');
      return receipt.length<=MAX_CALCULATION_RECEIPT_LENGTH?receipt:undefined;
    },
    read(receipt:unknown,request:CalculationRequest):Result {
      const value=readSignedPayload(receipt,signature);
      if(value?.schema!==1 || !validChartCalculationResult(value.result))throw invalid();
      if(value.binding!==binding(request,value.result))throw invalid();
      return value.result as Result;
    },
  };
}
