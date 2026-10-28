import { GATES } from './geometry/chart-geometry.ts';
import { GATE_MARKER, GATE_POINTER_RADIUS } from './geometry/drawing-presentation.ts';

const TOUCH_WIDTH = 44;
const TOUCH_HEIGHT = 44;

// Read one painted gate hit as the screen ruler for the shared, axis-aligned
// drawing. Native hits on planets and numbers keep priority; no coordinate cache.
export function pointerTarget(svg: SVGSVGElement, event: PointerEvent, surface?: Element | null) {
  const direct = (event.target as Element).closest<HTMLElement | SVGElement>('[data-type]');
  if (event.pointerType !== 'touch'
    || direct && !['center', 'channel', 'integration', 'planet-filter'].includes(direct.dataset.type!)) return direct;
  const visible = surface?.getBoundingClientRect();
  if (visible && (event.clientX < visible.left || event.clientX > visible.right
    || event.clientY < visible.top || event.clientY > visible.bottom)) return null;
  const shown = (rect: DOMRect) => !visible || rect.right > visible.left && rect.left < visible.right
    && rect.bottom > visible.top && rect.top < visible.bottom;
  // Native mouse/pen hits match the visible gate circle. Only a finger may
  // reach its former larger circle; this is independent of highlight style.
  if (!direct || direct.dataset.type !== 'planet-filter') {
    const layer = svg.querySelector<SVGGElement>('.bodygraph-gates');
    const reference = GATES[0];
    const anchor = layer?.querySelector<SVGCircleElement>(`[data-type="gate"][data-id="${reference.id}"] .bg-gate-hit`);
    const rect = anchor?.getBoundingClientRect();
    if (rect && rect.width > 0 && rect.height > 0
      && [rect.left, rect.top, rect.width, rect.height].every(Number.isFinite)) {
      // Camera and body presentation use only translation and axis-aligned scale.
      // The actual circle rectangle includes their CSS projection. An SVG CTM
      // that disagrees with that projection must not redirect Ego to gate 20.
      const rx = rect.width / 2, ry = rect.height / 2;
      const sx = rx / GATE_POINTER_RADIUS, sy = ry / GATE_POINTER_RADIUS;
      const x = reference.x + (event.clientX - rect.left - rx) / sx;
      const y = reference.y + (event.clientY - rect.top - ry) / sy;
      let gateId: number | null = null, nearest = Infinity;
      for (const gate of GATES) {
        const cx = rect.left + rx + (gate.x - reference.x) * sx;
        const cy = rect.top + ry + (gate.y - reference.y) * sy;
        if (visible && (cx + rx <= visible.left || cx - rx >= visible.right || cy + ry <= visible.top || cy - ry >= visible.bottom)) continue;
        const distance = (x - gate.x) ** 2 + (y - gate.y) ** 2;
        if (distance <= GATE_MARKER.hitRadius ** 2 && distance < nearest) { gateId = gate.id; nearest = distance; }
      }
      const gate = gateId === null ? null : layer!.querySelector<SVGElement>(`[data-type="gate"][data-id="${gateId}"]`);
      if (gate) return gate;
    }
    if (direct) return direct;
  }
  if (direct) {
    if (!visible) return direct;
    const frame = direct.querySelector('.activation-planet-filter-frame')?.getBoundingClientRect();
    return frame && shown(frame) ? direct : null;
  }
  const hits = [...svg.querySelectorAll('.activation-planet-filter-hit')].map(hit => {
    const rect = hit.getBoundingClientRect();
    const frame = visible ? hit.parentElement!.querySelector('.activation-planet-filter-frame')?.getBoundingClientRect() || rect : rect;
    return { control: hit.parentElement, frame, column: hit.closest('.activation-column'), rect,
      centerY: (rect.top + rect.bottom) / 2 };
  }).filter(({ rect, frame }) => rect.width > 0 && rect.height > 0
    && shown(frame));
  let target: HTMLElement | SVGElement | null = null, distance = Infinity;
  for (const hit of hits) {
    const { rect, centerY, column } = hit;
    const halfHeight = Math.max(TOUCH_HEIGHT, rect.height) / 2;
    let top = centerY - halfHeight, bottom = centerY + halfHeight;
    // Adjacent rows share their midpoint, never an overlapping hit area.
    for (const neighbor of hits) {
      if (neighbor.column !== column || neighbor === hit) continue;
      const boundary = (centerY + neighbor.centerY) / 2;
      if (neighbor.centerY < centerY) top = Math.max(top, boundary);
      else if (neighbor.centerY > centerY) bottom = Math.min(bottom, boundary);
    }
    // Expand toward the empty margin, keeping the original gap to the glyph.
    const left = Math.min(rect.left, rect.right - TOUCH_WIDTH);
    if (event.clientX < left || event.clientX > rect.right || event.clientY < top || event.clientY > bottom) continue;
    const delta = Math.abs(event.clientY - centerY);
    if (delta < distance) { target = hit.control; distance = delta; }
  }
  return target;
}
