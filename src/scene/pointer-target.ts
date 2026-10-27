import { GATE_MARKER, GATE_POINTER_RADIUS } from './geometry/drawing-presentation.ts';

const TOUCH_WIDTH = 44;
const TOUCH_HEIGHT = 44;

// Read screen bounds once at the start of a touch. Visual SVG geometry and the
// camera stay unchanged; direct hits on planets, numbers and the chart win.
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
    let gate: HTMLElement | SVGElement | null = null, nearest = Infinity;
    const expansion = GATE_MARKER.hitRadius / GATE_POINTER_RADIUS;
    for (const hit of svg.querySelectorAll<SVGCircleElement>('.bg-gate-hit')) {
      const rect = hit.getBoundingClientRect();
      if (!rect.width || !rect.height || !shown(rect)) continue;
      const dx = (event.clientX - (rect.left + rect.right) / 2) / (rect.width / 2 * expansion);
      const dy = (event.clientY - (rect.top + rect.bottom) / 2) / (rect.height / 2 * expansion);
      const distance = dx * dx + dy * dy;
      if (distance <= 1 && distance < nearest) {
        gate = hit.parentElement; nearest = distance;
      }
    }
    if (gate) return gate;
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
