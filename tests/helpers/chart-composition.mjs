import { createChartComposition } from '../../src/domain/chart-composition.js';

// Compact fixtures use the same strict constructor as the accepted scene.
export const overlayFixture = (primary, secondary, options) => createChartComposition(primary, {
  id: options?.kind === 'return' ? `${primary.id}:cycle:${options.event?.id}` : `${primary.id}:transit-preview`,
  primaryLabel: primary.name || '', ...options, secondary,
});
