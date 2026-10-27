import { createLifetimeMoments as createMoments } from '../../server/services/lifetime.ts';
import { createRequestHandler as createHandler } from '../../server/http/app.ts';
import type { CalculationRequest } from '../../shared/chart-types.ts';
import type { LifetimeMetadata } from '../../shared/lifetime-format.ts';

// Service validation tests deliberately feed incomplete and malformed file data.
export type TestCalculate = (input: CalculationRequest, options?: { signal?: AbortSignal }) => unknown;
type MomentOptions = NonNullable<Parameters<typeof createMoments>[0]>;
export type TestMomentOptions = Omit<MomentOptions, 'lifetimeFile'> & {
  lifetimeFile?: { metadata: Partial<LifetimeMetadata>; cacheIdentity?: string; provenanceVerified?: boolean; getPoint(index: number): unknown } | null;
};
export const createLifetimeMoments = createMoments as (options: TestMomentOptions) => ReturnType<typeof createMoments>;

type HandlerOptions = Parameters<typeof createHandler>[0];
type TestHandlerOptions = Omit<Partial<HandlerOptions>, 'calculate' | 'lifetime'> & Pick<HandlerOptions, 'root'> & {
  calculate?: TestCalculate; lifetime?: Partial<NonNullable<HandlerOptions['lifetime']>>;
};
export const createRequestHandler = createHandler as (options: TestHandlerOptions) => ReturnType<typeof createHandler>;
