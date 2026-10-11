const editable = element => Boolean(element && !element.readOnly && !element.disabled &&
  (element.isContentEditable || element.tagName === 'TEXTAREA' || element.tagName === 'INPUT' &&
    ['text', 'search', 'tel', 'url', 'email', 'password', 'number'].includes(element.type)));

// One page-lifetime source for visible bounds. Its consumer applies layout
// before notifying popups; this module knows nothing about their DOM or anchors.
export function createViewport({ surface, viewport = surface.ownerDocument?.defaultView?.visualViewport, onChange = () => {} }) {
  const document = surface.ownerDocument, window = document?.defaultView;
  let editingFinished = false, focusFrame = null, destroyed = false;
  const valid = () => viewport && Number.isFinite(viewport.height) && viewport.height > 0 && Number.isFinite(viewport.offsetTop);
  function bounds(full) {
    const useVisual = valid() && !editingFinished;
    return { left: Number.isFinite(viewport?.offsetLeft) ? viewport.offsetLeft : 0,
      top: useVisual ? viewport.offsetTop : full.top || 0,
      width: Number.isFinite(viewport?.width) && viewport.width > 0 ? viewport.width : full.width,
      height: useVisual ? viewport.height : full.height };
  }
  function read() { return bounds(surface.getBoundingClientRect()); }
  function refresh() {
    if (destroyed) return;
    const full = surface.getBoundingClientRect();
    // Safari may retain keyboard height after Done. Resume native geometry only
    // when it catches up, accounting for page zoom and fractional CSS pixels.
    const scale = Number.isFinite(viewport?.scale) && viewport.scale > 0 ? viewport.scale : 1;
    if (valid() && viewport.height * scale >= full.height - 1) editingFinished = false;
    onChange(bounds(full));
  }
  function focusIn(event) {
    if (!editable(event.target)) return;
    if (focusFrame !== null) window.cancelAnimationFrame(focusFrame);
    focusFrame = null;
    editingFinished = false;
    refresh();
  }
  function focusOut(event) {
    if (!editable(event.target) || editable(event.relatedTarget) || focusFrame !== null) return;
    // Blur temporarily focuses the body. Resolve the completed transition;
    // focusing another editor cancels this frame, including С → По.
    focusFrame = window.requestAnimationFrame(() => {
      focusFrame = null;
      editingFinished = !editable(document.activeElement);
      refresh();
    });
  }
  window?.addEventListener?.('resize', refresh);
  // Document scrolling bubbles to window. Nested element scrolling does not;
  // popups separately observe their moving anchors with capture listeners.
  window?.addEventListener?.('scroll', refresh);
  viewport?.addEventListener?.('resize', refresh);
  viewport?.addEventListener?.('scroll', refresh);
  document?.addEventListener?.('focusin', focusIn);
  document?.addEventListener?.('focusout', focusOut);
  return { read, refresh,
    destroy() {
      destroyed = true;
      if (focusFrame !== null) window.cancelAnimationFrame(focusFrame);
      focusFrame = null;
      window?.removeEventListener?.('resize', refresh);
      window?.removeEventListener?.('scroll', refresh);
      viewport?.removeEventListener?.('resize', refresh);
      viewport?.removeEventListener?.('scroll', refresh);
      document?.removeEventListener?.('focusin', focusIn);
      document?.removeEventListener?.('focusout', focusOut);
    },
  };
}
