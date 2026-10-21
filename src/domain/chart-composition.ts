import type { ChartData, Activation } from '../../shared/chart-types.ts';
import type { CycleEvent } from '../../shared/cycles-format.ts';
export interface PlanetFilterView {
  perPlanetControls: boolean;
  selectedPlanets: readonly string[];
  selectedDesignPlanets: readonly string[];
  activations: readonly Activation[];
  designActivations: readonly Activation[];
}
export type ChartInput = Partial<ChartData> & { planetFilter?: PlanetFilterView };
export type CompositionEvent = Pick<CycleEvent, 'id'> & Partial<CycleEvent>;
interface CompositionBase {
  primary: ChartInput;
  topology: { personality: readonly number[]; design: readonly number[] };
  utc?: string;
  id: string | null;
  primaryLabel: string;
}
export type ChartComposition = CompositionBase & (
  { kind: 'single'; secondary: null; event: null }
  | { kind: 'transit'; secondary: ChartInput; event: null }
  | { kind: 'return'; secondary: ChartInput; event: CompositionEvent }
);
export type ChartView = ChartInput | ChartComposition;
interface CompositionOptions {
  secondary?: ChartInput | null;
  kind?: ChartComposition['kind'];
  event?: CompositionEvent | null;
  id?: string | null;
  primaryLabel?: string;
}

// A composition names the actual inputs. Topology is a separate, small snapshot:
// neither a moment's metadata nor another chart's activation rows are spread
// into a synthetic chart. The records remain owned by their original caller.
const validGates = (values: unknown) => (Array.isArray(values) ? values : []).map(Number)
  .filter(gate => Number.isInteger(gate) && gate >= 1 && gate <= 64);
const union = (a: unknown, b: unknown) => Object.freeze([...new Set([...validGates(a), ...validGates(b)])].sort((a, b) => a - b));

export function createChartComposition(primary: ChartInput, { secondary = null, kind = 'single', event = null, id = null, primaryLabel = '' }: CompositionOptions = {}): ChartComposition {
  if (!primary || typeof primary !== 'object') throw new TypeError('A primary chart is required');
  if (!['single', 'transit', 'return'].includes(kind)) throw new TypeError('Composition kind must be single, transit or return');
  if (kind === 'single' && secondary) throw new TypeError('A single composition has only one source');
  if (kind !== 'single' && (!secondary || typeof secondary !== 'object')) throw new TypeError('An overlay requires its secondary chart');
  if (kind === 'return' && !event?.id) throw new TypeError('Return composition requires its event');
  if (kind !== 'return' && event) throw new TypeError('Only a return composition has an event');
  const topology = Object.freeze({ personality: union(primary.personality, secondary?.personality), design: union(primary.design, secondary?.design) });
  // Navigation supplies identity and captions. Chart data has neither a
  // library ID nor a person's name, even when it describes their birth.
  return Object.freeze({ kind, primary, secondary, event, topology, utc: (secondary || primary).utc, id, primaryLabel }) as ChartComposition;
}

// Plain charts remain supported by standalone previews and low-level tools.
// They are read directly, so those callers can update a raw chart in place.
export const isChartComposition = (input: unknown): input is ChartComposition => {
  const value = input as Partial<ChartComposition> | null;
  return Boolean(value?.primary && value?.topology && (value.kind === 'single' || value.kind === 'transit' || value.kind === 'return'));
};
export const isChartOverlay = (value: unknown): value is Extract<ChartComposition, { kind: 'transit' | 'return' }> => isChartComposition(value) && value.kind !== 'single';
export const primaryChart = (value: ChartView): ChartInput => isChartComposition(value) ? value.primary : value;
export const chartTopology = (value: ChartView): Pick<ChartInput, 'personality' | 'design'> => isChartComposition(value) ? value.topology : value;
