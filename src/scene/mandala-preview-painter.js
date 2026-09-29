import { MANDALA_CENTER, mandalaCrossKey, mandalaCrossGeometry } from './geometry/mandala-geometry.js';

const overlapsPinned = (cross, pinned) => pinned.some(value => value.longitude === cross.longitude && value.source === cross.source);

// The four gates own every highlight outside the moving overlay. A different
// gate/source tuple needs a full render; line/profile changes only move its marks.
function paintKey(cross) {
  const key = mandalaCrossKey(cross);
  if (!key || !Array.isArray(cross.gates) || cross.gates.length !== 4
    || !cross.positions.every((position, index) => cross.gates[index] === position.gate)) return null;
  return `${cross.source || 'personality'}:${key}`;
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
    const geometry = mandalaCrossGeometry(cross);
    geometry.positions.forEach((position, index) => {
      const { mark, ray, circle } = cache.positions[index];
      const [x, y] = geometry.points[index];
      mark.setAttribute('data-longitude', String(position.longitude));
      ray.setAttribute('d', `M ${MANDALA_CENTER} L ${x} ${y}`);
      circle.setAttribute('cx', String(x));
      circle.setAttribute('cy', String(y));
    });
    cache.cursor.setAttribute('d', geometry.cursorPath);
    cache.group.setAttribute('data-cross-type', geometry.type);
    return true;
  }
  return { capture, update, clear };
}
