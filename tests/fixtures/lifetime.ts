import { createMomentTimeline as createExplorer } from '../../src/state/moment-timeline.ts';
import type { LifetimeClient } from '../../src/data/lifetime-client.ts';

type ExplorerOptions = NonNullable<Parameters<typeof createExplorer>[0]>;
export type TestLifetimeOptions = Omit<ExplorerOptions, 'client' | 'dayClient' | 'natalDayClient'> & { client?: Partial<LifetimeClient>; dayClient?: Partial<TransitDayClient> | null; natalDayClient?: Partial<NatalDayClient> | null };

// Scenarios provide only the transport operations they exercise; results keep their real contracts.
export const createMomentTimeline = createExplorer as (options?: TestLifetimeOptions) => ReturnType<typeof createExplorer>;

import { createLifetimeClient as createClient } from '../../src/data/lifetime-client.ts';
import type { TransitDayClient } from '../../src/data/transit-day-client.ts';
import type { NatalDayClient } from '../../src/data/natal-day-client.ts';
type ClientOptions = NonNullable<Parameters<typeof createClient>[0]>;
type TestClientOptions = Omit<ClientOptions, 'dayClient' | 'natalDayClient'> & {
  dayClient?: Partial<TransitDayClient> | null; natalDayClient?: Partial<NatalDayClient> | null;
};
export const createLifetimeClient = createClient as (options?: TestClientOptions) => ReturnType<typeof createClient>;
