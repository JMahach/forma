// Preview is transient and never commits a selection or opens a data popover.
export function attachHoverPreview(svg, { onPreview }) {
  let current = null;
  const same = (a, b) => a?.type === b?.type && a?.id === b?.id;
  function set(value) {
    if (same(current, value)) return;
    current = value;
    onPreview(value);
  }
  function clear({ notify = true } = {}) {
    if (!current) return;
    current = null;
    if (notify) onPreview(null);
  }
  // Pointermove, rather than over/out, avoids enter/leave feedback when the
  // renderer replaces SVG children beneath a stationary mouse pointer.
  svg.addEventListener('pointermove', event => {
    if (event.pointerType === 'touch' || event.buttons || svg.classList.contains('is-dragging')) { clear(); return; }
    const target = event.target.closest?.('[data-type]');
    if (!target || !svg.contains(target)) { clear(); return; }
    const type = target?.dataset.type;
    if (!['gate', 'center', 'channel', 'integration'].includes(type)) { clear(); return; }
    const id = type === 'gate' ? Number(target.dataset.id) : target.dataset.id;
    if (type === 'gate' && (!Number.isInteger(id) || id < 1 || id > 64)) { clear(); return; }
    set({ type, id });
  });
  svg.addEventListener('pointerleave', () => clear());
  svg.addEventListener('pointerdown', event => { if (event.pointerType === 'touch') clear(); });
  svg.addEventListener('wheel', () => clear(), { passive: true });
  window.addEventListener('blur', () => clear());
  document.addEventListener('visibilitychange', () => { if (document.hidden) clear(); });
  return { clear, get currentSelection() { return current ? { ...current } : null; } };
}
