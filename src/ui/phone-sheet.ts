import type { ViewportBounds } from './layout/viewport.ts';
export type SheetMode = 'collapsed' | 'medium' | 'expanded';
interface PhoneSheet { panel: HTMLElement; handle: HTMLButtonElement; content?: HTMLElement; initialMode?: SheetMode; onClose: () => void; onReveal?: () => void; onModeChange?: (mode: SheetMode) => void }
interface SheetDrag { pointerId: number; startY: number; lastY: number; startHeight: number; mode: SheetMode; lastTime: number; lastMotion: number; velocity: number; moved: boolean }
interface SheetEntry extends PhoneSheet {
  mode: SheetMode; opened: boolean; bounds: { maximum: number; medium: number } | null;
  drag: SheetDrag | null; suppressClick: boolean; originalExpanded: string | null; listeners: [string, EventListener][];
}
interface PhoneSheetOptions { sheets: PhoneSheet[]; isPhone: () => boolean; readViewport?: () => Pick<ViewportBounds, 'top' | 'height'>; readStyle?: (panel: HTMLElement) => CSSStyleDeclaration | undefined }
export type PhoneSheets = ReturnType<typeof attachPhoneSheets>;

const HEIGHT = '--phone-sheet-height';
const PEEK_HEIGHT = 32;
const MODES: readonly SheetMode[] = ['collapsed', 'medium', 'expanded'];
const TAP_SLOP = 6, SWIPE_DISTANCE = 24, SWIPE_SPEED = .65, SWIPE_RECENCY = 120;
const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));

// Only the handles own drag gestures. Panel visibility, viewport changes and
// content scrolling remain with their existing owners; call refresh after them.
export function attachPhoneSheets({ sheets, isPhone, readViewport,
  readStyle = panel => panel.ownerDocument?.defaultView?.getComputedStyle?.(panel) }: PhoneSheetOptions) {
  let destroyed = false;
  const entries: SheetEntry[] = sheets.map(sheet => ({ ...sheet, mode: sheet.initialMode ?? 'medium', opened: false, bounds: null,
    drag: null, suppressClick: false, originalExpanded: sheet.handle.getAttribute('aria-expanded'), listeners: [] }));
  const usable = (entry: SheetEntry) => !destroyed && isPhone() && entry.panel.classList.contains('open') && !entry.panel.inert && !entry.handle.disabled;
  function measure(entry: SheetEntry) {
    const window = entry.panel.ownerDocument?.defaultView || globalThis;
    const viewport = readViewport?.() || { top: window.visualViewport?.offsetTop || 0,
      height: window.visualViewport?.height || window.innerHeight };
    const fullHeight = window.innerHeight || viewport.height;
    // A translated opening/closing panel has a misleading rectangle bottom.
    const style = readStyle(entry.panel);
    const inset = parseFloat(style?.bottom!);
    const topClearance = parseFloat(style?.scrollPaddingTop!) || 64;
    const bottom = Number.isFinite(inset) ? fullHeight - inset : entry.panel.getBoundingClientRect().bottom;
    const top = viewport.top || 0;
    const maximum = Math.max(PEEK_HEIGHT, Math.min(bottom, top + viewport.height) - top - topClearance);
    return { maximum, medium: Math.min(maximum, fullHeight * .52) };
  }
  const modeHeight = (entry: SheetEntry, mode: SheetMode) => mode === 'collapsed' ? PEEK_HEIGHT
    : entry.bounds![mode === 'expanded' ? 'maximum' : 'medium'];
  const adjacent = (mode: SheetMode, direction: number) => MODES[clamp(MODES.indexOf(mode) + direction, 0, MODES.length - 1)]!;
  function paint(entry: SheetEntry, height = modeHeight(entry, entry.mode)) {
    entry.panel.style.setProperty(HEIGHT, `${height}px`);
    entry.panel.dataset.sheetSize = entry.mode;
    const collapsed = entry.mode === 'collapsed';
    entry.handle.setAttribute('aria-expanded', String(entry.opened && !collapsed));
    if (entry.content) {
      if (collapsed && entry.opened && entry.content.contains(entry.panel.ownerDocument.activeElement)) {
        entry.handle.focus({ preventScroll: true });
      }
      entry.content.inert = collapsed;
    }
  }
  function release(entry: SheetEntry) {
    const drag = entry.drag;
    if (!drag) return null;
    entry.drag = null;
    delete entry.panel.dataset.sheetDragging;
    if (entry.handle.hasPointerCapture?.(drag.pointerId)) entry.handle.releasePointerCapture(drag.pointerId);
    return drag;
  }
  function cancel(entry: SheetEntry) {
    const drag = release(entry);
    if (!drag) return;
    entry.suppressClick = drag.moved;
    entry.mode = drag.mode;
    paint(entry);
  }
  function clean(entry: SheetEntry) {
    release(entry);
    entry.opened = false; entry.suppressClick = false;
    entry.panel.style.removeProperty(HEIGHT);
    if (entry.content) entry.content.inert = false;
    delete entry.panel.dataset.sheetSize;
    delete entry.panel.dataset.sheetDragging;
    if (entry.originalExpanded === null) entry.handle.removeAttribute('aria-expanded');
    else entry.handle.setAttribute('aria-expanded', entry.originalExpanded);
  }
  function refresh() {
    if (destroyed) return;
    const phone = isPhone();
    for (const entry of entries) {
      if (!phone) { clean(entry); continue; }
      if (!entry.panel.classList.contains('open')) {
        cancel(entry); entry.opened = false;
        entry.handle.setAttribute('aria-expanded', 'false');
        // Keep the last settled height for the outgoing CSS transition.
        continue;
      }
      const bounds = measure(entry);
      if (entry.drag && (Math.abs(bounds.maximum - entry.bounds!.maximum) > .5 || Math.abs(bounds.medium - entry.bounds!.medium) > .5)) cancel(entry);
      entry.bounds = bounds;
      entry.opened = true;
      if (!entry.drag) paint(entry);
    }
  }
  function settle(entry: SheetEntry, mode: SheetMode) {
    const previousMode = entry.mode;
    const revealing = entry.mode === 'collapsed' && mode !== 'collapsed' && entry.opened;
    cancel(entry);
    entry.mode = mode;
    entry.bounds = measure(entry);
    paint(entry);
    if (revealing) entry.onReveal?.();
    if (entry.mode !== previousMode) entry.onModeChange?.(entry.mode);
  }
  function command(panel: HTMLElement, reveal: boolean) {
    if (destroyed || !isPhone()) return;
    const entry = entries.find(value => value.panel === panel);
    if (!entry) return;
    // Commands may precede PanelState opening the shell. Refresh retains this
    // choice instead of replacing it with another sheet's height.
    settle(entry, reveal && entry.mode !== 'collapsed' ? entry.mode : reveal ? 'medium' : 'collapsed');
  }
  for (const entry of entries) {
    const listen = <K extends keyof HTMLElementEventMap>(type: K, callback: (event: HTMLElementEventMap[K]) => void) => {
      entry.handle.addEventListener(type, callback);
      entry.listeners.push([type, callback as EventListener]);
    };
    listen('pointerdown', event => {
      if (!usable(entry) || entry.drag || event.isPrimary === false || event.button !== 0) return;
      for (const other of entries) cancel(other);
      refresh();
      entry.suppressClick = false;
      const actualHeight = entry.panel.getBoundingClientRect().height;
      entry.drag = { pointerId: event.pointerId, startY: event.clientY, lastY: event.clientY,
        startHeight: clamp(actualHeight, PEEK_HEIGHT, entry.bounds!.maximum), mode: entry.mode,
        lastTime: event.timeStamp, lastMotion: event.timeStamp, velocity: 0, moved: false };
      entry.panel.dataset.sheetDragging = 'true';
      // Commit the currently displayed height before disabling settling motion.
      paint(entry, entry.drag.startHeight);
      entry.handle.setPointerCapture?.(event.pointerId);
    });
    const move = (event: PointerEvent) => {
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
        paint(entry, clamp(drag.startHeight + drag.startY - event.clientY, PEEK_HEIGHT, entry.bounds!.maximum));
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
      const height = clamp(drag.startHeight - travel, PEEK_HEIGHT, entry.bounds!.maximum);
      const downwardFlick = travel > SWIPE_DISTANCE && velocity > SWIPE_SPEED;
      const upwardFlick = travel < -SWIPE_DISTANCE && velocity < -SWIPE_SPEED;
      const nearest = MODES.reduce((best, mode) => Math.abs(height - modeHeight(entry, mode)) < Math.abs(height - modeHeight(entry, best)) ? mode : best, drag.mode);
      settle(entry, downwardFlick || upwardFlick ? adjacent(drag.mode, downwardFlick ? -1 : 1) : nearest);
    });
    for (const type of ['pointercancel', 'lostpointercapture'] as const) listen(type, event => {
      if (entry.drag?.pointerId === event.pointerId) cancel(entry);
    });
    listen('click', event => {
      if (entry.suppressClick && event.detail !== 0) {
        entry.suppressClick = false; event.preventDefault(); event.stopPropagation(); return;
      }
      if (!usable(entry)) return;
      settle(entry, entry.mode === 'medium' ? 'expanded' : 'medium');
    });
    listen('keydown', event => {
      if (!usable(entry) || event.altKey || event.ctrlKey || event.metaKey || !['ArrowUp', 'ArrowDown', 'Escape'].includes(event.key)) return;
      event.preventDefault(); event.stopPropagation();
      settle(entry, event.key === 'Escape' ? 'collapsed' : adjacent(entry.mode, event.key === 'ArrowUp' ? 1 : -1));
    });
  }
  refresh();
  return { refresh, getMode(panel: HTMLElement) { return entries.find(entry => entry.panel === panel)?.mode; }, collapse(panel: HTMLElement) { command(panel, false); }, reveal(panel: HTMLElement) { command(panel, true); }, destroy() {
    if (destroyed) return;
    destroyed = true;
    for (const entry of entries) {
      for (const [type, callback] of entry.listeners) entry.handle.removeEventListener(type, callback);
      clean(entry);
    }
  } };
}
