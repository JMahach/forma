import type { ChartInput } from '../../src/domain/chart-composition.ts';
import type { CycleEvent } from '../../shared/cycles-format.ts';
import type { CycleEventsResult } from '../../shared/cycles-format.ts';
import { createCyclesClient as createClient, type CyclesClient } from '../../src/data/cycles-client.ts';
import { createReturnsController as createController } from '../../src/state/returns.ts';
import {createReturnStorage} from '../../src/data/return-storage.ts';
import {createCalculationCache} from '../../src/data/calculation-cache.ts';
import {DEFAULT_CYCLE_BODIES} from '../../src/domain/cycles.ts';
import type {CycleInput} from '../../shared/cycles-format.ts';
import {MAX_RETURN_PROOF_LENGTH,type PreparedReturn} from '../../shared/chart-return-contract.ts';

/** Seed historical dates for migration tests; the live writer no longer exists. */
export function createLegacyReturnStorage(options:Parameters<typeof createReturnStorage>[0]={}) {
  const cache=options.cache??createCalculationCache(options),storage=createReturnStorage({...options,cache});
  return {...storage,
    putEvents(key:string,input:CycleInput,data:PreparedReturn<CycleEventsResult>) {
      if(!DEFAULT_CYCLE_BODIES.includes(input.body))return Promise.resolve(null);
      const proof=typeof data.proof==='string' && data.proof.length>0 && data.proof.length<=MAX_RETURN_PROOF_LENGTH?{proof:data.proof}:{};
      return cache.put('return-events',key,{key,birthUtc:input.birthUtc,body:input.body,range:data.range,...proof,
        events:data.events.map(({utc,cycle,pass,direction})=>({utc,cycle,pass,direction}))});
    },
    close(){storage.close();if(!options.cache)cache.close();},
  };
}
export type LegacyReturnStorage=ReturnType<typeof createLegacyReturnStorage>;

type ClientOptions = NonNullable<Parameters<typeof createClient>[0]>;
export type TestCyclesOptions = Omit<ClientOptions, 'returnStorage'> & { returnStorage?: (Partial<LegacyReturnStorage> & {touchEvents?:(key:string)=>unknown}) | null };
type ControllerOptions = NonNullable<Parameters<typeof createController>[0]>;
export type TestReturnsClient = Omit<Partial<CyclesClient>, 'events' | 'chart'> & {
  chart?: (...args: Parameters<CyclesClient['chart']>) => Promise<{ chart: ChartInput; event?: CycleEvent }>;
  events?: (...args: Parameters<CyclesClient['events']>) => Promise<Pick<CycleEventsResult, 'events'> & Partial<Omit<CycleEventsResult, 'events'>>>;
};
export type TestReturnsOptions = Omit<ControllerOptions, 'client'> & { client?: TestReturnsClient };

// Each test supplies the transport/storage operations used by that scenario.
export const createCyclesClient = createClient as (options?: TestCyclesOptions) => ReturnType<typeof createClient>;
export const createReturnsController = createController as (options?: TestReturnsOptions) => ReturnType<typeof createController>;
