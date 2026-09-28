import { createFrameMonitor } from '../diagnostics/frame-monitor.js';

// This view observes input without owning gestures, camera state or rendering.
// Sampling and its bounded statistics belong to diagnostics/frame-monitor.
export function attachPerformanceMonitor({ document, button, panel, drawing, ranges = [], motionButtons = [],
  initiallyEnabled = false, onToggle = () => {}, monitorOptions = {},
}) {
  const field = name => panel.querySelector(`[data-performance="${name}"]`);
  const fields = Object.fromEntries(['fps', 'pauses', 'max'].map(name => [name, field(name)]));
  const closeButton = panel.querySelector('[data-performance-close]');
  let enabled = false, destroyed = false;
  const pointers = new Map(), listeners = [];
  const text = (element, value) => { if (element.textContent !== value) element.textContent = value; };
  const milliseconds = value => value === null ? '—' : `${value.toFixed(1)} мс`;

  function render(state) {
    text(fields.fps, state.recentSampleCount < 3 ? '—' : `≈${Math.round(state.recentFps)}`);
    text(fields.pauses, state.sampleCount ? String(state.longGapCount) : '—');
    text(fields.max, milliseconds(state.maxIntervalMs));
  }
  const monitor = createFrameMonitor({ ...monitorOptions, onUpdate: render });
  const activity = () => { if (enabled && !document.hidden) monitor.activity(); };
  function listen(target, type, handler) {
    const options = { passive: true, capture: true };
    target.addEventListener(type, handler, options);
    listeners.push(() => target.removeEventListener(type, handler, options));
  }
  function suspend() { pointers.clear(); monitor.stop(); render(monitor.getSnapshot()); }
  function observeDrag(surface) {
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
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
      listen(surface, type, event => {
        if (pointers.get(event.pointerId)?.surface === surface) pointers.delete(event.pointerId);
      });
    }
  }
  function observe() {
    observeDrag(drawing);
    listen(drawing, 'wheel', event => { if (event.deltaX || event.deltaY) activity(); });
    listen(drawing, 'keydown', event => {
      if (event.target === drawing && ['+', '-', '0'].includes(event.key)) activity();
    });
    for (const range of ranges) {
      observeDrag(range);
      listen(range, 'input', () => { if (!range.disabled) activity(); });
    }
    for (const control of motionButtons) listen(control, 'click', activity);
    listen(document, 'visibilitychange', suspend);
    if (document.defaultView) listen(document.defaultView, 'pagehide', suspend);
  }
  function setEnabled(value) {
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
