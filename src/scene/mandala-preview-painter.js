import { MANDALA_GEOMETRY, mandalaPoint } from './geometry/mandala-geometry.js';

const TYPES = new Set(['right-angle', 'juxtaposition', 'left-angle']);
const SOURCES = new Set(['personality', 'design']);
const overlapsPinned = (cross, pinned) => pinned.some(value => value.longitude === cross.longitude && value.source === cross.source);

// The four gates own every highlight outside the moving overlay. A different
// gate/source tuple needs a full render; line/profile changes only move its marks.
function paintKey(cross) {
  if (!TYPES.has(cross?.type) || !SOURCES.has(cross.source === undefined ? 'personality' : cross.source)
    || !Array.isArray(cross.positions) || cross.positions.length !== 4
    || !Array.isArray(cross.gates) || cross.gates.length !== 4) return null;
  if (!cross.positions.every((position, index) => position && SOURCES.has(position.source)
    && ['sun', 'earth'].includes(position.planet) && Number.isFinite(position.longitude)
    && position.longitude >= 0 && position.longitude < 360
    && Number.isInteger(position.gate) && position.gate >= 1 && position.gate <= 64
    && cross.gates[index] === position.gate)) return null;
  if (new Set(cross.positions.map(position => `${position.source}:${position.planet}`)).size !== 4) return null;
  return `${cross.source || 'personality'}:${cross.positions.map(position => `${position.source}:${position.planet}:${position.gate}`).join(',')}`;
}

// A DOM cache, not selection state. Capture only after the authoritative full
// render, and refuse stale/detached nodes instead of attempting to repair them.
export function createMandalaPreviewPainter(viewport) {
  let cache = null;
  function clear() { cache = null; }
  function capture(cross, pinned = []) {
    clear();
    const key = paintKey(cross);
    if (!key || overlapsPinned(cross, pinned)) return;
    const group = viewport.querySelector('.mandala-cross-preview');
    if (!group) return;
    const positions = [...group.querySelectorAll('.mandala-cross-position')].map(mark => ({
      mark, ray: mark.querySelector('.mandala-cross-preview-ray'), circle: mark.querySelector('circle'),
    }));
    const cursor = group.querySelector('.mandala-cross-cursor');
    if (positions.length !== 4 || !cursor || positions.some(position => !position.ray || !position.circle)) return;
    cache = { key, group, positions, cursor, nodes: [group, cursor, ...positions.flatMap(({ mark, ray, circle }) => [mark, ray, circle])] };
  }
  function update(cross, pinned = []) {
    if (!cache || cache.key !== paintKey(cross) || overlapsPinned(cross, pinned)
      || !cache.nodes.every(node => viewport.contains(node))) return false;
    const { centerX, centerY, innerRadius, outerRadius } = MANDALA_GEOMETRY;
    cross.positions.forEach((position, index) => {
      const { mark, ray, circle } = cache.positions[index];
      const [x, y] = mandalaPoint(position.longitude, innerRadius);
      mark.setAttribute('data-longitude', String(position.longitude));
      ray.setAttribute('d', `M ${centerX} ${centerY} L ${x} ${y}`);
      circle.setAttribute('cx', String(x));
      circle.setAttribute('cy', String(y));
    });
    const cursor = cross.positions.find(position => position.source === (cross.source || 'personality') && position.planet === 'sun');
    cache.cursor.setAttribute('d', `M ${mandalaPoint(cursor.longitude, outerRadius - 3).join(' ')} L ${mandalaPoint(cursor.longitude, outerRadius + 6).join(' ')}`);
    cache.group.setAttribute('data-cross-type', cross.type);
    return true;
  }
  return { capture, update, clear };
}
