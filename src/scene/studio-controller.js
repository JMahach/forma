import { computeStudioLayout, STUDIO_BOTTOM_INSET, returnsPlacement, computeTimelineDock } from './layout.js';
import { STUDIO_FRAME } from './geometry/frames.js';

// Phone chrome is presentation, not a branch in camera or chart geometry.
export const PHONE_LAYOUT_QUERY = '(max-width: 699px), (pointer: coarse) and (max-width: 1099px) and (max-height: 500px)';

export function createStudioLayout({ canvas, panels, returnsControls = null, studio = canvas.parentElement, drawing = null, art = null, readStyle = element => getComputedStyle(element),
  media = globalThis.matchMedia(PHONE_LAYOUT_QUERY), viewport = globalThis.visualViewport }) {
  const phone = () => media.matches;
  let current, dockHeight = 0;
  const document = studio?.ownerDocument, window = document?.defaultView;
  let editingFinished = false, focusFrame = null;
  const editable = element => Boolean(element && !element.readOnly && !element.disabled &&
    (element.isContentEditable || element.tagName === 'TEXTAREA' || element.tagName === 'INPUT' &&
      ['text', 'search', 'tel', 'url', 'email', 'password', 'number'].includes(element.type)));
  // Keyboard and browser chrome can resize/pan only the visual viewport.
  // Move the controls as one surface without changing the scene or camera fit.
  function refreshViewport() {
    if (!studio) return;
    const full = studio.getBoundingClientRect();
    const bottom = full.bottom ?? (full.top || 0) + full.height;
    const valid = viewport && Number.isFinite(viewport.height) && viewport.height > 0 && Number.isFinite(viewport.offsetTop);
    // Safari can keep the keyboard's old height after Done. Do not let a
    // delayed resize/scroll lift the dock again after editing has finished.
    const scale = Number.isFinite(viewport?.scale) && viewport.scale > 0 ? viewport.scale : 1;
    // Visual pixels shrink under native page zoom; allow subpixel rounding.
    if (valid && viewport.height * scale >= full.height - 1) editingFinished = false;
    const lift = valid && !editingFinished ? Math.max(0, Math.min(full.height, bottom - viewport.offsetTop - viewport.height)) : 0;
    studio.style?.setProperty('--timeline-viewport-lift', `${lift}px`);
    // The fixed backing reaches the viewport edge, including behind Safari UI.
    studio.style?.setProperty('--timeline-dock-top', `${bottom - lift - dockHeight}px`);
  }
  function refresh() {
    const style = readStyle(canvas);
    const insets = { side: parseFloat(style.scrollPaddingLeft) || 4,
      top: parseFloat(style.scrollPaddingTop) || 112,
      bottom: parseFloat(style.scrollPaddingBottom) || STUDIO_BOTTOM_INSET };
    let dock = null;
    if (studio) {
      const full = studio.getBoundingClientRect();
      const safeInset = parseFloat(style.getPropertyValue('--timeline-safe-bottom')) || 0;
      const safeBottom = Math.max(safeInset, parseFloat(style.getPropertyValue('--timeline-edge-space')) || 0);
      const lifetime = panels.find(panel => panel.id === 'lifetimeControls');
      const natal = panels.find(panel => panel.id === 'natalDayControls');
      const timelineKind = returnsControls && !returnsControls.hidden ? 'returns'
        : natal && !natal.hidden ? 'natal-day'
        : lifetime && !lifetime.hidden && lifetime.dataset.personalLife !== 'true' ? 'chronicle' : 'day';
      const fields = timelineKind === 'chronicle' ? [...(lifetime.querySelectorAll?.('.lifetime-date-control') || [])] : [];
      const controlWidth = fields.length ? Math.ceil(Math.max(...fields.map(field => field.getBoundingClientRect().width))) || undefined : undefined;
      dock = computeTimelineDock({ width: full.width, height: full.height, ...insets, safeBottom, kind: timelineKind, controlWidth });
      // Panels cover the scene; opening a second row must not reframe Home.
      const baseDock = computeTimelineDock({ width: full.width, height: full.height, ...insets, safeBottom });
      insets.bottom = baseDock.height;
      insets.footerHeight = baseDock.height;
      insets.safeBottom = safeBottom;
      studio.style?.setProperty('--timeline-dock-height', `${dock.height}px`);
      dockHeight = dock.height;
      // Center dates in the visible dock; the rail's label clearance is not a device safe area.
      studio.style?.setProperty('--timeline-heading-top', `${full.height - dock.height + (dock.mode === 'inline' ? (dock.height - safeInset - 44) / 2 : 0)}px`);
      studio.style?.setProperty('--timeline-gutter', `${dock.gutter}px`);
      studio.style?.setProperty('--timeline-action-gutter', `${dock.actionGutter}px`);
      studio.style?.setProperty('--timeline-action-size', `${dock.actionSize}px`);
      studio.style?.setProperty('--timeline-action-width', `${dock.actionWidth}px`);
      studio.style?.setProperty('--timeline-content-width', `${Math.max(1, full.width - 2 * dock.gutter)}px`);
      const placement = returnsPlacement({ width: full.width, height: full.height, ...insets },
        { phone: phone(), reserve: parseFloat(style.getPropertyValue('--returns-side-space')) });
      if (studio.dataset.returnsLayout !== placement) studio.dataset.returnsLayout = placement;
    }
    // Placement changes the canvas width. Measure after its CSS is applied.
    const rect = canvas.getBoundingClientRect(), offsetLeft = canvas.offsetLeft || 0;
    current = computeStudioLayout({ width: rect.width, height: rect.height, ...insets });
    canvas.dataset.layout = phone() ? 'phone' : 'desktop';
    canvas.dataset.mandalaColumns = current.showMandalaColumns ? 'visible' : 'hidden';
    if (art) {
      // Its STUDIO_FRAME viewBox uses the camera's exact fitting rectangle,
      // including the shared vertical shift and responsive safe-area insets.
      const { x, y, width, height } = current.area;
      Object.assign(art.style, { left: `${x}px`, top: `${y}px`, width: `${width}px`, height: `${height}px`, visibility: 'visible' });
    }
    const { placement } = current;
    const panel = dock?.rail || current.panel;
    const left = `${panel.x + (dock ? 0 : offsetLeft)}px`;
    for (const element of panels) {
      element.dataset.placement = placement;
      element.style.left = left;
      element.style.top = `${panel.y}px`;
      element.style.width = `${panel.width}px`;
      if (dock) {
        element.style.setProperty('--rail-left', left);
        element.style.setProperty('--rail-top', `${panel.y}px`);
      }
    }
    if (drawing) {
      // The small control surface covers only its own footprint. A footer-wide
      // clip would unnecessarily erase the zoomed drawing on either side.
      // The canvas's existing drawer clip remains responsible for side drawers.
      drawing.style.clipPath = 'none';
    }
    refreshViewport();
    return current;
  }
  refresh();
  // This singleton survives the startup → app handoff for the page lifetime.
  viewport?.addEventListener('resize', refreshViewport);
  viewport?.addEventListener('scroll', refreshViewport);
  document?.addEventListener('focusin', event => {
    if (!editable(event.target)) return;
    if (focusFrame !== null) window.cancelAnimationFrame(focusFrame);
    focusFrame = null;
    editingFinished = false;
    refreshViewport();
  });
  document?.addEventListener('focusout', event => {
    if (!editable(event.target) || editable(event.relatedTarget) || focusFrame !== null) return;
    // Resolve the completed focus transition, not the temporary body focus
    // inside blur. A new editor cancels this frame, including С → По.
    focusFrame = window.requestAnimationFrame(() => {
      focusFrame = null;
      editingFinished = !editable(document.activeElement);
      refreshViewport();
    });
  });
  return {
    get returnsLayout() { return studio?.dataset.returnsLayout || 'sheet'; },
    get phone() { return phone(); },
    get showMandalaColumns() { return current.showMandalaColumns; },
    get placement() { return current.placement; },
    get mandalaTop() { return current.center.y - current.mandalaRadius; },
    frame() { return STUDIO_FRAME; },
    refresh,
    insets() { return current.insets; },
  };
}
