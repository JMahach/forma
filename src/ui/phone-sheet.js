const HEIGHT = '--phone-sheet-height';
const TAP_SLOP = 6, SWIPE_DISTANCE = 24, SWIPE_SPEED = .65, SWIPE_RECENCY = 120;
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));

// Only the handles own drag gestures. Panel visibility, viewport changes and
// content scrolling remain with their existing owners; call refresh after them.
export function attachPhoneSheets({ sheets, isPhone, readViewport,
  readStyle = panel => panel.ownerDocument?.defaultView?.getComputedStyle?.(panel) } = {}) {
  let destroyed = false, currentMode = 'medium';
  const entries = sheets.map(sheet => ({ ...sheet, mode: 'medium', opened: false, bounds: null,
    drag: null, suppressClick: false, originalExpanded: sheet.handle.getAttribute('aria-expanded'), listeners: [] }));
  const usable = entry => !destroyed && isPhone() && entry.panel.classList.contains('open') && !entry.panel.inert && !entry.handle.disabled;
  function measure(entry) {
    const window = entry.panel.ownerDocument?.defaultView || globalThis;
    const viewport = readViewport?.() || { top: window.visualViewport?.offsetTop || 0,
      height: window.visualViewport?.height || window.innerHeight };
    const fullHeight = window.innerHeight || viewport.height;
    // A translated opening/closing panel has a misleading rectangle bottom.
    const style = readStyle(entry.panel);
    const inset = parseFloat(style?.bottom);
    const topClearance = parseFloat(style?.scrollPaddingTop) || 64;
    const bottom = Number.isFinite(inset) ? fullHeight - inset : entry.panel.getBoundingClientRect().bottom;
    const top = viewport.top || 0;
    const maximum = Math.max(44, Math.min(bottom, top + viewport.height) - top - topClearance);
    return { maximum, medium: Math.min(maximum, fullHeight * .52) };
  }
  function paint(entry, height = entry.bounds[entry.mode === 'expanded' ? 'maximum' : 'medium']) {
    entry.panel.style.setProperty(HEIGHT, `${height}px`);
    entry.panel.dataset.sheetSize = entry.mode;
    entry.handle.setAttribute('aria-expanded', String(entry.opened && entry.mode === 'expanded'));
  }
  function release(entry) {
    const drag = entry.drag;
    if (!drag) return null;
    entry.drag = null;
    delete entry.panel.dataset.sheetDragging;
    if (entry.handle.hasPointerCapture?.(drag.pointerId)) entry.handle.releasePointerCapture(drag.pointerId);
    return drag;
  }
  function cancel(entry) {
    const drag = release(entry);
    if (!drag) return;
    entry.suppressClick = drag.moved;
    entry.mode = drag.mode;
    paint(entry);
  }
  function clean(entry) {
    release(entry);
    entry.opened = false; entry.mode = 'medium'; entry.suppressClick = false;
    entry.panel.style.removeProperty(HEIGHT);
    delete entry.panel.dataset.sheetSize;
    delete entry.panel.dataset.sheetDragging;
    if (entry.originalExpanded === null) entry.handle.removeAttribute('aria-expanded');
    else entry.handle.setAttribute('aria-expanded', entry.originalExpanded);
  }
  function refresh() {
    if (destroyed) return;
    const phone = isPhone();
    if (!phone || !entries.some(entry => entry.panel.classList.contains('open'))) currentMode = 'medium';
    for (const entry of entries) {
      if (!phone) { clean(entry); continue; }
      if (!entry.panel.classList.contains('open')) {
        cancel(entry); entry.opened = false;
        entry.handle.setAttribute('aria-expanded', 'false');
        // Keep the last settled height for the outgoing CSS transition.
        continue;
      }
      const bounds = measure(entry);
      if (entry.drag && (Math.abs(bounds.maximum - entry.bounds.maximum) > .5 || Math.abs(bounds.medium - entry.bounds.medium) > .5)) cancel(entry);
      entry.bounds = bounds;
      if (!entry.opened) { entry.mode = currentMode; entry.opened = true; }
      if (!entry.drag) paint(entry);
    }
  }
  function settle(entry, mode) {
    cancel(entry);
    entry.mode = currentMode = mode;
    entry.bounds = measure(entry);
    paint(entry);
  }
  function dismiss(entry) {
    release(entry);
    entry.opened = false;
    entry.handle.setAttribute('aria-expanded', 'false');
    entry.onClose();
  }
  for (const entry of entries) {
    const listen = (type, callback) => {
      entry.handle.addEventListener(type, callback);
      entry.listeners.push([type, callback]);
    };
    listen('pointerdown', event => {
      if (!usable(entry) || entry.drag || event.isPrimary === false || event.button !== 0) return;
      for (const other of entries) cancel(other);
      refresh();
      entry.suppressClick = false;
      const actualHeight = entry.panel.getBoundingClientRect().height;
      entry.drag = { pointerId: event.pointerId, startY: event.clientY, lastY: event.clientY,
        startHeight: clamp(actualHeight, 44, entry.bounds.maximum), mode: entry.mode,
        lastTime: event.timeStamp, lastMotion: event.timeStamp, velocity: 0, moved: false };
      entry.panel.dataset.sheetDragging = 'true';
      // Commit the currently displayed height before disabling settling motion.
      paint(entry, entry.drag.startHeight);
      entry.handle.setPointerCapture?.(event.pointerId);
    });
    const move = event => {
      const drag = entry.drag;
      if (!drag || event.pointerId !== drag.pointerId) return;
      if (!usable(entry)) { cancel(entry); return; }
      const delta = event.clientY - drag.lastY;
      if (delta) {
        drag.velocity = delta / Math.max(1, event.timeStamp - drag.lastTime);
        drag.lastMotion = event.timeStamp;
      }
      drag.lastY = event.clientY; drag.lastTime = event.timeStamp;
      drag.moved ||= Math.abs(event.clientY - drag.startY) > TAP_SLOP;
      if (drag.moved) {
        event.preventDefault();
        paint(entry, clamp(drag.startHeight + drag.startY - event.clientY, 44, entry.bounds.maximum));
      }
    };
    listen('pointermove', move);
    listen('pointerup', event => {
      if (!entry.drag || event.pointerId !== entry.drag.pointerId) return;
      move(event);
      const drag = release(entry);
      if (!drag) return;
      if (!drag.moved) { paint(entry); return; }
      entry.suppressClick = true;
      const travel = event.clientY - drag.startY;
      const velocity = event.timeStamp - drag.lastMotion <= SWIPE_RECENCY ? drag.velocity : 0;
      const height = clamp(drag.startHeight - travel, 44, entry.bounds.maximum);
      if (height < entry.bounds.medium * .65 || travel > SWIPE_DISTANCE && velocity > SWIPE_SPEED) {
        dismiss(entry); return;
      }
      const upwardFlick = travel < -SWIPE_DISTANCE && velocity < -SWIPE_SPEED;
      entry.mode = currentMode = upwardFlick || height > (entry.bounds.medium + entry.bounds.maximum) / 2 ? 'expanded' : 'medium';
      paint(entry);
    });
    for (const type of ['pointercancel', 'lostpointercapture']) listen(type, event => {
      if (entry.drag?.pointerId === event.pointerId) cancel(entry);
    });
    listen('click', event => {
      if (entry.suppressClick && event.detail !== 0) {
        entry.suppressClick = false; event.preventDefault(); event.stopPropagation(); return;
      }
      if (!usable(entry)) return;
      settle(entry, entry.mode === 'expanded' ? 'medium' : 'expanded');
    });
    listen('keydown', event => {
      if (!usable(entry) || event.altKey || event.ctrlKey || event.metaKey || !['ArrowUp', 'ArrowDown', 'Escape'].includes(event.key)) return;
      event.preventDefault(); event.stopPropagation();
      if (event.key === 'Escape' || event.key === 'ArrowDown' && entry.mode === 'medium') dismiss(entry);
      else settle(entry, event.key === 'ArrowUp' ? 'expanded' : 'medium');
    });
  }
  refresh();
  return { refresh, destroy() {
    if (destroyed) return;
    destroyed = true;
    for (const entry of entries) {
      for (const [type, callback] of entry.listeners) entry.handle.removeEventListener(type, callback);
      clean(entry);
    }
  } };
}
