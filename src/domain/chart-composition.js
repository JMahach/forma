// A composition names the actual inputs. Topology is a separate, small snapshot:
// neither a moment's metadata nor another chart's activation rows are spread
// into a synthetic chart. The records remain owned by their original caller.
const validGates = values => (Array.isArray(values) ? values : []).map(Number)
  .filter(gate => Number.isInteger(gate) && gate >= 1 && gate <= 64);
const union = (a, b) => Object.freeze([...new Set([...validGates(a), ...validGates(b)])].sort((a, b) => a - b));

export function createChartComposition(primary, { secondary = null, kind = 'single', event = null } = {}) {
  if (!primary || typeof primary !== 'object') throw new TypeError('A primary chart is required');
  if (!['single', 'transit', 'return'].includes(kind)) throw new TypeError('Composition kind must be single, transit or return');
  if (kind === 'single' && secondary) throw new TypeError('A single composition has only one source');
  if (kind !== 'single' && (!secondary || typeof secondary !== 'object')) throw new TypeError('An overlay requires its secondary chart');
  if (kind === 'return' && !event?.id) throw new TypeError('Return composition requires its event');
  if (kind !== 'return' && event) throw new TypeError('Only a return composition has an event');
  const topology = Object.freeze({ personality: union(primary.personality, secondary?.personality), design: union(primary.design, secondary?.design) });
  const id = kind === 'single' ? primary.id : kind === 'return' ? `${primary.id}:cycle:${event.id}` : `${primary.id}:transit-preview`;
  return Object.freeze({ kind, primary, secondary, event, topology, utc: (secondary || primary).utc, id });
}

// Plain charts remain supported by standalone previews and low-level tools.
// They are read directly, so those callers can update a raw chart in place.
export const isChartComposition = value => Boolean(value?.primary && value?.topology && (value.kind === 'single' || value.kind === 'transit' || value.kind === 'return'));
export const isChartOverlay = value => isChartComposition(value) && value.kind !== 'single';
export const primaryChart = value => isChartComposition(value) ? value.primary : value;
export const chartTopology = value => isChartComposition(value) ? value.topology : value;
