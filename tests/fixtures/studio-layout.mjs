import { STUDIO_FOOTPRINT } from '../../src/scene/geometry/frames.js';
import { createStudioLayout as createLayout } from '../../src/ui/layout/studio-controller.js';
import { computeStudioLayout as computeLayout, returnsPlacement as placeReturns } from '../../src/ui/layout/studio.js';

export const createStudioLayout = options => createLayout({ footprint: STUDIO_FOOTPRINT, ...options });
export const computeStudioLayout = options => computeLayout({ footprint: STUDIO_FOOTPRINT, ...options });
export const returnsPlacement = (options, policy) => placeReturns({ footprint: STUDIO_FOOTPRINT, ...options }, policy);
