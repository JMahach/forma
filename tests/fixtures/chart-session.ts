import type { NatalDayExplorer } from '../../src/state/natal-day.ts';
import { createChartSession as createSession } from '../../src/state/chart-session.ts';
import { createChartExploration as createExploration } from '../../src/state/chart-exploration.ts';
import type { ChartInput } from '../../src/domain/chart-composition.ts';
import type { SavedChart } from '../../shared/chart-types.ts';
import type { ReturnsController } from '../../src/state/returns.ts';
import type { LifetimeExplorer } from '../../src/state/lifetime.ts';
import type { LiveTransit } from '../../src/state/live-transit.ts';

type SessionOptions = Parameters<typeof createSession>[0];
type ExplorationOptions = Parameters<typeof createExploration>[0];
type StateOwner<T extends { state: object }> = Partial<Omit<T, 'state'>> & { state?: Partial<T['state']> };
type TestReturns = Omit<StateOwner<ReturnsController>, 'select' | 'close' | 'enableMarkers'> & { enableMarkers?: (...args: Parameters<ReturnsController['enableMarkers']>) => unknown; close?: () => unknown; select?: (...args: Parameters<ReturnsController['select']>) => unknown };
export type TestLifetime = StateOwner<LifetimeExplorer>;
type TestNatalDay = Omit<StateOwner<NatalDayExplorer>, 'open'> & { open?: () => boolean | Promise<boolean> };
type TestTransit = Omit<StateOwner<LiveTransit>, 'goNow'> & { goNow?: () => unknown };
interface TestSessionOptions extends Omit<SessionOptions, 'store' | 'getReturns' | 'getTransit' | 'getNatalDay'> {
  store: { get(id: string): Partial<SavedChart> | null | undefined; has(id: string): boolean };
  getNatalDay?: () => TestNatalDay | null;
  getReturns?: () => Pick<TestReturns, 'exit' | 'select'> | null;
  getTransit?: () => { current: ChartInput | null; setWanted?(value: boolean): void } | null;
}
interface TestExplorationOptions extends Omit<ExplorationOptions, 'getReturns' | 'getLifetime' | 'getTransit' | 'loadLifetime' | 'getNatalDay'> {
  getNatalDay: () => TestNatalDay | null;
  getReturns: () => TestReturns | null;
  getLifetime: () => TestLifetime | null;
  getTransit: () => TestTransit | null;
  loadLifetime?: () => Promise<TestLifetime | null>;
}
// State-owner scenarios supply only the neighboring ports used in that path.
export const createChartSession = createSession as (options: TestSessionOptions) => ReturnType<typeof createSession>;
export const createChartExploration = createExploration as (options: TestExplorationOptions) => ReturnType<typeof createExploration>;
