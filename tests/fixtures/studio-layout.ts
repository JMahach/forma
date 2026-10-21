import type { TestStub } from '../helpers/test-stub.ts';
import { STUDIO_FOOTPRINT } from '../../src/scene/geometry/frames.ts';
import { createStudioLayout as createLayout } from '../../src/ui/layout/studio-controller.ts';
import { computeStudioLayout as computeLayout, returnsPlacement as placeReturns } from '../../src/ui/layout/studio.ts';

export const createStudioLayout = (options: TestStub<Parameters<typeof createLayout>[0]>) => createLayout({ footprint: STUDIO_FOOTPRINT, ...options } as Parameters<typeof createLayout>[0]);
export const computeStudioLayout = (options: TestStub<Parameters<typeof computeLayout>[0]>) => computeLayout({ footprint: STUDIO_FOOTPRINT, ...options } as Parameters<typeof computeLayout>[0]);
export const returnsPlacement = (options: TestStub<Parameters<typeof placeReturns>[0]>, policy?: Parameters<typeof placeReturns>[1]) => placeReturns({ footprint: STUDIO_FOOTPRINT, ...options } as Parameters<typeof placeReturns>[0], policy);
