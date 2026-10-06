import { createChartComposition } from '../../src/domain/chart-composition.js';

// Compact fixtures use the same strict constructor as the accepted scene.
export const overlayFixture = (primary, secondary, options) => createChartComposition(primary, { ...options, secondary });
