import type { ChartInput } from '../../src/domain/chart-composition.ts';
import type { CycleEvent } from '../../shared/cycles-format.ts';
import type { CycleEventsResult } from '../../shared/cycles-format.ts';
import { createCyclesClient as createClient, type CyclesClient } from '../../src/data/cycles-client.ts';
import { createReturnsController as createController } from '../../src/state/returns.ts';
import type { ReturnStorage } from '../../src/data/return-storage.ts';

type ClientOptions = NonNullable<Parameters<typeof createClient>[0]>;
export type TestCyclesOptions = Omit<ClientOptions, 'returnStorage'> & { returnStorage?: Partial<ReturnStorage> | null };
type ControllerOptions = NonNullable<Parameters<typeof createController>[0]>;
export type TestReturnsClient = Omit<Partial<CyclesClient>, 'events' | 'chart'> & {
  chart?: (...args: Parameters<CyclesClient['chart']>) => Promise<{ chart: ChartInput; event?: CycleEvent }>;
  events?: (...args: Parameters<CyclesClient['events']>) => Promise<Pick<CycleEventsResult, 'events'> & Partial<Omit<CycleEventsResult, 'events'>>>;
};
export type TestReturnsOptions = Omit<ControllerOptions, 'client'> & { client?: TestReturnsClient };

// Each test supplies the transport/storage operations used by that scenario.
export const createCyclesClient = createClient as (options?: TestCyclesOptions) => ReturnType<typeof createClient>;
export const createReturnsController = createController as (options?: TestReturnsOptions) => ReturnType<typeof createController>;
