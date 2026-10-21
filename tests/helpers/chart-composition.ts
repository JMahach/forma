import type { ChartInput, ChartComposition } from '../../src/domain/chart-composition.ts';
import { createChartComposition } from '../../src/domain/chart-composition.ts';

// Compact fixtures use the same strict constructor as the accepted scene.
export const overlayFixture = <Primary extends ChartInput & { id?: string; name?: string }, Secondary extends ChartInput>(primary: Primary, secondary: Secondary, options?: Parameters<typeof createChartComposition>[1]) => createChartComposition(primary, {
  id: options?.kind === 'return' ? `${primary.id}:cycle:${options.event?.id}` : `${primary.id}:transit-preview`,
  primaryLabel: primary.name || '', ...options, secondary,
}) as Extract<ChartComposition, { kind: 'transit' | 'return' }> & { primary: Primary; secondary: Secondary };
