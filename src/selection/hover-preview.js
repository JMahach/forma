// Preview is transient and never commits a selection or opens a data popover.
export function attachHoverPreview(svg, {
  onPreview, onClear = () => {}, resolvePreview = () => null, resolveKeyboard = () => null,
  coalesceMandala = false,
  requestFrame = callback => window.requestAnimationFrame(callback),
  cancelFrame = handle => window.cancelAnimationFrame(handle),
}) {
  let current = null, pendingFrame = null;
  const same = (a, b) => a?.type === b?.type && a?.id === b?.id;
  function cancelPendingFrame() {
    if (!pendingFrame) return;
    const frame = pendingFrame;
    pendingFrame = null;
    cancelFrame(frame.handle);
  }
  function set(value, defer = false) {
    if (same(current, value)) {
      // Keyboard feedback stays immediate even when this angle was queued by
      // the pointer and has not yet been painted.
      if (!defer && pendingFrame) { cancelPendingFrame(); onPreview(current); }
      return;
    }
    current = value;
    if (defer) {
      if (!pendingFrame) {
        const frame = { handle: null };
        pendingFrame = frame;
        frame.handle = requestFrame(() => {
          if (pendingFrame !== frame) return;
          pendingFrame = null;
          onPreview(current);
        });
      }
      return;
    }
    cancelPendingFrame();
    onPreview(value);
  }
  function clear({ notify = true } = {}) {
    cancelPendingFrame();
    if (!current) return;
    current = null;
    onClear();
    if (notify) onPreview(null);
  }
  // Pointermove, rather than over/out, avoids enter/leave feedback when the
  // renderer replaces SVG children beneath a stationary mouse pointer.
  svg.addEventListener('pointermove', event => {
    if (event.pointerType === 'touch' || event.buttons || svg.classList.contains('is-dragging')) { clear(); return; }
    const target = event.target.closest?.('[data-type]');
    if (!target || !svg.contains(target)) { clear(); return; }
    const resolved = resolvePreview(event, target);
    if (resolved) { set(resolved, coalesceMandala && resolved.type === 'mandala-cross'); return; }
    const type = target?.dataset.type;
    if (!['gate', 'center', 'channel', 'integration'].includes(type)) { clear(); return; }
    const id = type === 'gate' ? Number(target.dataset.id) : target.dataset.id;
    if (type === 'gate' && (!Number.isInteger(id) || id < 1 || id > 64)) { clear(); return; }
    set({ type, id });
  });
  svg.addEventListener('pointerleave', () => clear());
  svg.addEventListener('keydown', event => {
    if (event.key === 'Escape') { clear(); return; }
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const direction = ['ArrowRight', 'ArrowDown'].includes(event.key) ? 1
      : ['ArrowLeft', 'ArrowUp'].includes(event.key) ? -1 : 0;
    if (!direction) return;
    const target = event.target.closest?.('[data-type]');
    if (!target || !svg.contains(target)) return;
    const resolved = resolveKeyboard(target, current, direction);
    if (resolved) { event.preventDefault(); set(resolved); }
  });
  svg.addEventListener('pointerdown', event => { if (event.pointerType === 'touch') clear(); });
  svg.addEventListener('wheel', () => clear(), { passive: true });
  window.addEventListener('blur', () => clear());
  document.addEventListener('visibilitychange', () => { if (document.hidden) clear(); });
  return { clear, get currentSelection() { return current ? { ...current } : null; } };
}
