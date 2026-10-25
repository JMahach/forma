import type { PreviewSelection, SelectionType } from './selection-targets.ts';
interface HoverPreviewOptions {
  surface?: Element;
  onPreview: (selection: PreviewSelection | null) => void;
  onClear?: () => void;
  resolvePreview?: (event: PointerEvent, target: HTMLElement | SVGElement) => PreviewSelection | null;
  resolveKeyboard?: (target: HTMLElement | SVGElement, current: PreviewSelection | null, direction: number) => PreviewSelection | null;
  coalesceMandala?: boolean;
  requestFrame?: (callback: FrameRequestCallback) => number;
  cancelFrame?: (handle: number) => void;
}

// Preview is transient and never commits a selection or opens a data popover.
export function attachHoverPreview(svg: SVGSVGElement, {
  surface = svg, onPreview, onClear = () => {}, resolvePreview = () => null, resolveKeyboard = () => null,
  coalesceMandala = false,
  requestFrame = callback => window.requestAnimationFrame(callback),
  cancelFrame = handle => window.cancelAnimationFrame(handle),
}: HoverPreviewOptions) {
  let mousePoint: { x: number; y: number } | null = null;
  let current: PreviewSelection | null = null, pendingFrame: { handle: number | null } | null = null;
  const same = (a: PreviewSelection | null, b: PreviewSelection | null) => a?.type === b?.type && a?.id === b?.id;
  function cancelPendingFrame() {
    if (!pendingFrame) return;
    const frame = pendingFrame;
    pendingFrame = null;
    cancelFrame(frame.handle!);
  }
  function set(value: PreviewSelection | null, defer = false) {
    if (same(current, value)) {
      // Keyboard feedback stays immediate even when this angle was queued by
      // the pointer and has not yet been painted.
      if (!defer && pendingFrame) { cancelPendingFrame(); onPreview(current); }
      return;
    }
    current = value;
    if (defer) {
      if (!pendingFrame) {
        const frame: { handle: number | null } = { handle: null };
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
  function clear({ notify = true, forgetPointer = true } = {}) {
    if (forgetPointer) mousePoint = null;
    cancelPendingFrame();
    if (!current) return;
    current = null;
    onClear();
    if (notify) onPreview(null);
  }
  function rememberPointer(event: Pick<MouseEvent, 'clientX' | 'clientY'> & { pointerType?: string }) {
    if (event.pointerType && event.pointerType !== 'mouse') { mousePoint = null; return; }
    if (Number.isFinite(event.clientX) && Number.isFinite(event.clientY)) mousePoint = { x: event.clientX, y: event.clientY };
  }
  // Camera paint and mouse release can leave a center under a stationary
  // cursor. Resolve its whole scope through the normal preview owner, not
  // only the center's CSS :hover outline. Capture targets are not hit targets.
  function refreshCenter({ clearOther = true } = {}) {
    const target = mousePoint && document.elementFromPoint(mousePoint.x, mousePoint.y)
      ?.closest<HTMLElement | SVGElement>('[data-type]');
    if (target && svg.contains(target) && target.dataset.type === 'center') {
      set({ type: 'center', id: target.dataset.id! });
    } else if (clearOther || current?.type === 'center') clear({ forgetPointer: false });
  }
  // Pointermove, rather than over/out, avoids enter/leave feedback when the
  // renderer replaces SVG children beneath a stationary mouse pointer.
  surface.addEventListener('pointermove', raw => {
    const event = raw as PointerEvent;
    rememberPointer(event);
    if (event.pointerType === 'touch') { clear(); return; }
    if (event.buttons || svg.classList.contains('is-dragging')) {
      if (current?.type !== 'center') clear({ forgetPointer: false });
      return;
    }
    const target = (event.target as Element).closest?.<HTMLElement | SVGElement>('[data-type]');
    if (!target || !svg.contains(target)) { clear(); return; }
    const resolved = resolvePreview(event, target);
    if (resolved) { set(resolved, coalesceMandala && resolved.type === 'mandala-cross'); return; }
    const type = target?.dataset.type as SelectionType;
    if (!['gate', 'center', 'channel', 'integration', 'planet'].includes(type)) { clear(); return; }
    const id = type === 'gate' ? Number(target.dataset.id) : target.dataset.id!;
    if (type === 'gate' && (!Number.isInteger(id) || (id as number) < 1 || (id as number) > 64)) { clear(); return; }
    set({ type, id });
  });
  surface.addEventListener('pointerleave', () => clear());
  svg.addEventListener('keydown', event => {
    if (event.key === 'Escape') { clear(); return; }
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const direction = ['ArrowRight', 'ArrowDown'].includes(event.key) ? 1
      : ['ArrowLeft', 'ArrowUp'].includes(event.key) ? -1 : 0;
    if (!direction) return;
    const target = (event.target as Element).closest?.<HTMLElement | SVGElement>('[data-type]');
    if (!target || !svg.contains(target)) return;
    const resolved = resolveKeyboard(target, current, direction);
    if (resolved) { event.preventDefault(); set(resolved); }
  });
  surface.addEventListener('pointerdown', raw => {
    const event = raw as PointerEvent;
    rememberPointer(event);
    if (event.pointerType === 'touch') clear();
  });
  // Attached after the gesture owner: selection and the last camera frame
  // have settled before we restore hover after a mouse release.
  surface.addEventListener('pointerup', raw => {
    const event = raw as PointerEvent;
    if (event.pointerType !== 'mouse') return;
    rememberPointer(event);
    refreshCenter({ clearOther: false });
  });
  surface.addEventListener('pointercancel', () => clear());
  surface.addEventListener('wheel', raw => {
    rememberPointer(raw as WheelEvent);
    // The camera's next painted frame performs the fresh hit-test.
    if (current?.type !== 'center') clear({ forgetPointer: false });
  }, { passive: true });
  window.addEventListener('blur', () => clear());
  document.addEventListener('visibilitychange', () => { if (document.hidden) clear(); });
  return { clear, refreshCenter, get currentSelection() { return current ? { ...current } : null; } };
}
