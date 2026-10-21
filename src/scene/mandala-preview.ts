import type { PreviewSelection } from '../selection/selection-targets.ts';
type PointerCoordinates = Pick<MouseEvent, 'clientX' | 'clientY'>;
import { MANDALA_GEOMETRY } from './geometry/mandala-geometry.ts';
import { GATE_ORDER, GATE_LONGITUDE_START, GATE_WIDTH } from '../domain/gate-wheel.ts';
import { crossAtLongitude } from '../domain/mandala-cross.ts';

// The wheel only pans and scales along the screen axes. Measure its own circle,
// not the whole group (planet labels extend it). Safari's SVG screen matrix can
// omit CSS scaling, while these bounds follow the circle actually on screen.
export function mandalaPreviewFromPointer(event: PointerCoordinates, target: HTMLElement | SVGElement) {
  if (!target.classList?.contains('mandala-gate')) return null;
  if (!Number.isFinite(event.clientX) || !Number.isFinite(event.clientY)) return null;
  const wheel = target.closest('.bodygraph-mandala');
  const bounds = wheel?.querySelector('.mandala-well')?.getBoundingClientRect();
  if (!bounds || ![bounds.left, bounds.top, bounds.width, bounds.height].every(Number.isFinite)
    || bounds.width <= 0 || bounds.height <= 0) return null;
  const dx = (event.clientX - bounds.left - bounds.width / 2) / (bounds.width / 2);
  const dy = (event.clientY - bounds.top - bounds.height / 2) / (bounds.height / 2);
  if (!Number.isFinite(dx) || !Number.isFinite(dy)
    || Math.hypot(dx, dy) < 1 / MANDALA_GEOMETRY.outerRadius) return null;
  const longitude = (Math.atan2(dy, -dx) * 180 / Math.PI + 360) % 360;
  return { ...previewAt(longitude), focusGate: Number(target.dataset.id) };
}

// The keyboard uses the middle of a gate, then walks the wheel in small
// increments so the narrow 4/1 transition is reachable without a mouse too.
export function mandalaPreviewFromFocus(target: HTMLElement | SVGElement, current?: PreviewSelection | null, direction = 0) {
  if (!target.classList?.contains('mandala-gate')) return null;
  const index = GATE_ORDER.indexOf(Number(target.dataset.id));
  if (index < 0) return null;
  const longitude = direction && current?.type === 'mandala-cross' && current.focusGate === Number(target.dataset.id)
    ? current.cross!.longitude + direction * GATE_WIDTH / 48
    : GATE_LONGITUDE_START + (index + .5) * GATE_WIDTH;
  return { ...previewAt(longitude), focusGate: Number(target.dataset.id) };
}

function previewAt(longitude: number) {
  const cross = crossAtLongitude(longitude);
  return { type: 'mandala-cross' as const, id: cross.longitude, cross };
}

export function mandalaSelectionFromTarget(event: PointerCoordinates | KeyboardEvent | null | undefined, target: HTMLElement | SVGElement, current?: PreviewSelection | null) {
  if (!target.classList?.contains('mandala-gate')) return null;
  const coordinates = event as Partial<PointerCoordinates> | null | undefined;
  const preview = Number.isFinite(coordinates?.clientX) && Number.isFinite(coordinates?.clientY)
    ? mandalaPreviewFromPointer(event as PointerCoordinates, target)
    : current?.type === 'mandala-cross' && current.focusGate === Number(target.dataset.id)
      ? current : mandalaPreviewFromFocus(target);
  return preview ? { type: 'mandala-cross' as const, id: preview.id, cross: preview.cross } : null;
}
