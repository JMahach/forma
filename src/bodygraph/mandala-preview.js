import { MANDALA_GEOMETRY } from './mandala.js';
import { GATE_ORDER, GATE_LONGITUDE_START, GATE_WIDTH } from '../domain/gate-wheel.js';
import { crossAtLongitude } from './mandala-cross.js';

// Convert from the screen through the wheel's own matrix. This keeps angular
// picking exact after pan, zoom, browser scaling and responsive camera fitting.
export function mandalaPreviewFromPointer(event, target) {
  if (!target.classList?.contains('mandala-gate')) return null;
  const wheel = target.closest('.bodygraph-mandala');
  const matrix = wheel?.getScreenCTM();
  if (!matrix || !Number.isFinite(event.clientX) || !Number.isFinite(event.clientY)) return null;
  let local;
  try { local = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse()); }
  catch { return null; }
  if (!Number.isFinite(local.x) || !Number.isFinite(local.y)) return null;
  const dx = local.x - MANDALA_GEOMETRY.centerX, dy = local.y - MANDALA_GEOMETRY.centerY;
  if (Math.hypot(dx, dy) < 1) return null;
  const longitude = (Math.atan2(dy, -dx) * 180 / Math.PI + 360) % 360;
  return { ...previewAt(longitude), focusGate: Number(target.dataset.id) };
}

// The keyboard uses the middle of a gate, then walks the wheel in small
// increments so the narrow 4/1 transition is reachable without a mouse too.
export function mandalaPreviewFromFocus(target, current, direction = 0) {
  if (!target.classList?.contains('mandala-gate')) return null;
  const index = GATE_ORDER.indexOf(Number(target.dataset.id));
  if (index < 0) return null;
  const longitude = direction && current?.type === 'mandala-cross' && current.focusGate === Number(target.dataset.id)
    ? current.cross.longitude + direction * GATE_WIDTH / 48
    : GATE_LONGITUDE_START + (index + .5) * GATE_WIDTH;
  return { ...previewAt(longitude), focusGate: Number(target.dataset.id) };
}

function previewAt(longitude) {
  const cross = crossAtLongitude(longitude);
  return { type: 'mandala-cross', id: cross.longitude, cross };
}

export function mandalaSelectionFromTarget(event, target, current) {
  if (!target.classList?.contains('mandala-gate')) return null;
  const preview = Number.isFinite(event?.clientX) && Number.isFinite(event?.clientY)
    ? mandalaPreviewFromPointer(event, target)
    : current?.type === 'mandala-cross' && current.focusGate === Number(target.dataset.id)
      ? current : mandalaPreviewFromFocus(target);
  return preview ? { type: 'mandala-cross', id: preview.id, cross: preview.cross } : null;
}
