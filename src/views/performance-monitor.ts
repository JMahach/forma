import type { FrameSnapshot, FrameMonitorOptions } from '../diagnostics/frame-monitor.ts';
type InputSurface = Element & { disabled?: boolean };
type PerformanceEventMap = HTMLElementEventMap & DocumentEventMap & WindowEventMap;
interface PerformanceMonitorOptions {
  document: Document; button: HTMLButtonElement; panel: HTMLElement; drawing: SVGSVGElement; inputSurface?: InputSurface;
  ranges?: HTMLInputElement[]; motionButtons?: HTMLButtonElement[]; initiallyEnabled?: boolean;
  onToggle?: (enabled: boolean) => void; monitorOptions?: FrameMonitorOptions;
}
export type PerformanceMonitor = ReturnType<typeof attachPerformanceMonitor>;

import { createFrameMonitor } from '../diagnostics/frame-monitor.ts';
import { setText } from '../ui/html.ts';

// This view observes input without owning gestures, camera state or rendering.
// Sampling and its bounded statistics belong to diagnostics/frame-monitor.
export function attachPerformanceMonitor({ document, button, panel, drawing, inputSurface = drawing, ranges = [], motionButtons = [],
  initiallyEnabled = false, onToggle = () => {}, monitorOptions = {},
}: PerformanceMonitorOptions) {
  const field = (name: string) => panel.querySelector<HTMLElement>(`[data-performance="${name}"]`);
  const fields = Object.fromEntries(['fps', 'pauses', 'max'].map(name => [name, field(name)]));
  const closeButton = panel.querySelector<HTMLButtonElement>('[data-performance-close]')!;
  let enabled = false, destroyed = false;
  const pointers = new Map<number, { surface: InputSurface; x: number; y: number }>(), listeners: (() => void)[] = [];
  const milliseconds = (value: number | null) => value === null ? '—' : `${value.toFixed(1)} мс`;

  function render(state: FrameSnapshot) {
    setText(fields.fps!, state.recentSampleCount < 3 ? '—' : `≈${Math.round(state.recentFps!)}`);
    setText(fields.pauses!, state.sampleCount ? String(state.longGapCount) : '—');
    setText(fields.max!, milliseconds(state.maxIntervalMs));
  }
  const monitor = createFrameMonitor({ ...monitorOptions, onUpdate: render });
  const activity = () => { if (enabled && !document.hidden) monitor.activity(); };
  function listen<K extends keyof PerformanceEventMap>(target: EventTarget, type: K, handler: (event: PerformanceEventMap[K]) => void) {
    const options = { passive: true, capture: true };
    target.addEventListener(type, handler as EventListener, options);
    listeners.push(() => target.removeEventListener(type, handler as EventListener, options));
  }
  function suspend() { pointers.clear(); monitor.stop(); render(monitor.getSnapshot()); }
  function observeDrag(surface: InputSurface) {
    listen(surface, 'pointerdown', event => {
      if (!document.hidden && !surface.disabled && (event.pointerType !== 'mouse' || event.button === 0)) {
        pointers.set(event.pointerId, { surface, x: event.clientX, y: event.clientY });
      }
    });
    listen(surface, 'pointermove', event => {
      const previous = pointers.get(event.pointerId);
      if (!previous || previous.surface !== surface) return;
      if (surface.disabled) { pointers.delete(event.pointerId); return; }
      pointers.set(event.pointerId, { surface, x: event.clientX, y: event.clientY });
      if (event.clientX !== previous.x || event.clientY !== previous.y) activity();
    });
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture'] as const) {
      listen(surface, type, event => {
        if (pointers.get(event.pointerId)?.surface === surface) pointers.delete(event.pointerId);
      });
    }
  }
  function observe() {
    observeDrag(inputSurface);
    listen(inputSurface, 'wheel', event => { if (event.deltaX || event.deltaY) activity(); });
    listen(drawing, 'keydown', event => {
      if (event.target === drawing && event.key === '0') activity();
    });
    for (const range of ranges) {
      observeDrag(range);
      listen(range, 'input', () => { if (!range.disabled) activity(); });
    }
    for (const control of motionButtons) listen(control, 'click', activity);
    listen(document, 'visibilitychange', suspend);
    if (document.defaultView) listen(document.defaultView, 'pagehide', suspend);
  }
  function setEnabled(value: boolean) {
    if (destroyed || enabled === Boolean(value)) return;
    enabled = Boolean(value);
    panel.hidden = !enabled;
    button.setAttribute('aria-pressed', String(enabled));
    button.setAttribute('aria-expanded', String(enabled));
    if (enabled) { observe(); render(monitor.getSnapshot()); }
    else { for (const remove of listeners.splice(0)) remove(); suspend(); }
  }
  function toggle() {
    setEnabled(!enabled);
    onToggle(enabled);
    if (enabled) closeButton.focus({ preventScroll: true });
  }
  function close() { setEnabled(false); drawing.focus({ preventScroll: true }); }
  button.addEventListener('click', toggle);
  closeButton.addEventListener('click', close);
  render(monitor.getSnapshot());
  setEnabled(initiallyEnabled);
  return {
    setEnabled,
    destroy() {
      if (destroyed) return;
      setEnabled(false);
      destroyed = true;
      button.removeEventListener('click', toggle);
      closeButton.removeEventListener('click', close);
      monitor.destroy();
    },
  };
}
