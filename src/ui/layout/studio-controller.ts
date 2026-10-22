import type { StudioFootprint, SidePanels, TimelineKind } from './studio.ts';
import type { ViewportBounds } from './viewport.ts';
export type StudioLayout = ReturnType<typeof createStudioLayout>;
interface StudioLayoutOptions {
  canvas: HTMLElement; panels: HTMLElement[]; footprint: StudioFootprint; studio?: HTMLElement;
  drawing?: SVGSVGElement | null; readStyle?: (element: Element) => CSSStyleDeclaration;
  media?: MediaQueryList; viewport?: VisualViewport | null; timelineKind?: TimelineKind;
  sidePanels?: () => SidePanels | null; onPhoneLayout?: (phone: boolean) => void;
}

import { computeStudioLayout, TIMELINE_BAR_HEIGHT, TIMELINE_WITH_DATES_HEIGHT, computeSidePanelLayout, computeTimelineDock } from './studio.ts';
import { createViewport } from './viewport.ts';
import { applyTimelineMetrics, TIMELINE_THUMB_SIZE } from './metrics.ts';

// Phone chrome is presentation, not a branch in camera or chart geometry.
export const PHONE_LAYOUT_QUERY = '(max-width: 699px), (pointer: coarse) and (max-width: 1099px) and (max-height: 500px)';

// Measure the existing controls even before their panel has been opened. The
// heading is independently hidden on personal timelines. Restore exact styles
// synchronously without changing hidden/inert or touching a visible editor.
function timelineControlWidth(panel: HTMLElement | undefined) {
  const fields = [...(panel?.querySelectorAll?.<HTMLElement>('.lifetime-date-control') || [])];
  if (!fields.length) return undefined;
  const heading = panel!.querySelector<HTMLElement>('.lifetime-heading')!;
  const restore = new Map<HTMLElement, string | null>();
  const style = (element: HTMLElement, properties: Record<string, string>) => {
    restore.set(element, element.getAttribute('style'));
    for (const [name, value] of Object.entries(properties)) element.style.setProperty(name, value, 'important');
  };
  try {
    if (panel!.hidden) style(panel!, { display: 'block', visibility: 'hidden' });
    if (panel!.hidden || heading.hidden) style(heading, {
      display: 'flex', visibility: 'hidden', width: 'max-content',
    });
    return Math.ceil(Math.max(...fields.map(field => field.getBoundingClientRect().width))) || undefined;
  } finally {
    for (const [element, original] of restore) {
      if (original === null) element.removeAttribute('style');
      else element.setAttribute('style', original);
    }
  }
}

export function createStudioLayout({ canvas, panels, footprint, studio = canvas.parentElement!, drawing = null, readStyle = element => getComputedStyle(element),
  media = globalThis.matchMedia(PHONE_LAYOUT_QUERY), viewport = globalThis.visualViewport, timelineKind = 'day', sidePanels = () => null, onPhoneLayout = () => {} }: StudioLayoutOptions) {
  const phone = () => media.matches;
  let current: ReturnType<typeof computeStudioLayout>, dock: ReturnType<typeof computeTimelineDock>, sideInsets: ReturnType<typeof computeSidePanelLayout>, appliedPhone: boolean | undefined;
  const viewportSubscribers = new Set<() => void>();
  let timelineHitOutset = 0;
  function applyViewport(visible: ViewportBounds) {
    const full = studio.getBoundingClientRect();
    const bottom = full.bottom ?? (full.top || 0) + full.height;
    const lift = Math.max(0, Math.min(full.height, bottom - visible.top - visible.height));
    studio.style?.setProperty('--timeline-viewport-lift', `${lift}px`);
    studio.style?.setProperty('--timeline-dock-top', `${bottom - lift - dock.backingHeight}px`);
    studio.parentElement?.style?.setProperty('--phone-viewport-lift', `${lift}px`);
    studio.parentElement?.style?.setProperty('--timeline-panels-bottom', `${Math.max(0, lift + dock.backingHeight)}px`);
    // A thin backing does not contain the slider's full touch target. The sheet
    // clears both that target and the floating dates; desktop keeps its rail edge.
    const sliderTop = dock.rail.y + dock.rail.height - TIMELINE_THUMB_SIZE - timelineHitOutset;
    const sheetClearance = Math.max(dock.height, full.height - Math.min(dock.rail.y, sliderTop));
    studio.parentElement?.style?.setProperty('--phone-sheet-bottom', `${Math.max(0, lift + sheetClearance)}px`);
    studio.parentElement?.style?.setProperty('--phone-sheet-clearance-gap', `${Math.max(0, sheetClearance - dock.height)}px`);
    // Popup anchors are measured only after the dock has accepted its position.
    for (const notify of [...viewportSubscribers]) notify();
  }
  const environment = createViewport({ surface: studio, viewport, onChange: applyViewport });
  applyTimelineMetrics(studio);
  function refresh() {
    const isPhone = phone();
    canvas.dataset.layout = isPhone ? 'phone' : 'desktop';
    if (appliedPhone !== isPhone) {
      appliedPhone = isPhone;
      onPhoneLayout(isPhone);
    }
    const style = readStyle(canvas);
    timelineHitOutset = Math.max(0, parseFloat(style.getPropertyValue('--timeline-hit-outset')) || 0);
    const full = studio.getBoundingClientRect();
    const safeInset = parseFloat(style.getPropertyValue('--timeline-safe-bottom')) || 0;
    const safeBottom = Math.max(safeInset, parseFloat(style.getPropertyValue('--timeline-edge-space')) || 0);
    // Keep the low rail backing for scale, and use headroom to clear the
    // date controls. Their placement preference is identical in every mode.
    const insets = { side: parseFloat(style.scrollPaddingLeft) || 4,
      top: parseFloat(style.scrollPaddingTop) || 112,
      bottom: TIMELINE_BAR_HEIGHT + safeBottom,
      footerHeight: TIMELINE_WITH_DATES_HEIGHT + safeBottom };
    const lifetime = panels.find(panel => panel.id === 'lifetimeControls');
    const controlWidth = timelineControlWidth(lifetime);
    sideInsets = computeSidePanelLayout({ ...sidePanels(), width: full.width, phone: phone() });
    studio.style?.setProperty('--studio-left-space', `${sideInsets.left}px`);
    studio.style?.setProperty('--studio-right-space', `${sideInsets.right}px`);
    if (studio.dataset.panelsLayout !== sideInsets.mode) studio.dataset.panelsLayout = sideInsets.mode;
    const placement = sideInsets.mode === 'side' ? 'side' : 'sheet';
    if (studio.dataset.returnsLayout !== placement) studio.dataset.returnsLayout = placement;
    // Placement changes the canvas width. Measure after its CSS is applied.
    const rect = canvas.getBoundingClientRect();
    current = computeStudioLayout({ footprint, width: rect.width, height: rect.height, ...insets });
    // Preserve the natural full-studio rail length, then fit its position and
    // visible span into the actual animated free area without changing camera geometry.
    const timelineHome = computeStudioLayout({ footprint, width: full.width, height: full.height, ...insets });
    const area = { x: (rect.left || 0) - (full.left || 0), width: rect.width };
    dock = computeTimelineDock({ width: full.width, height: full.height, side: insets.side, safeBottom,
      kind: timelineKind, controlWidth, chartWidth: timelineHome.columns.right - timelineHome.columns.left,
      area });
    studio.style?.setProperty('--timeline-dock-height', `${dock.height}px`);
    studio.style?.setProperty('--timeline-area-left', `${area.x}px`);
    studio.style?.setProperty('--timeline-area-width', `${area.width}px`);
    studio.style?.setProperty('--timeline-dates-left', `${dock.dates.x}px`);
    studio.style?.setProperty('--timeline-dates-width', `${dock.dates.width}px`);
    studio.style?.setProperty('--timeline-heading-height', `${dock.dates.height}px`);
    studio.style?.setProperty('--timeline-heading-top', `${dock.dates.y}px`);
    studio.style?.setProperty('--timeline-gutter', `${dock.gutter}px`);
    studio.style?.setProperty('--timeline-content-left', `${area.x + dock.gutter}px`);
    studio.style?.setProperty('--timeline-content-width', `${Math.max(1, area.width - 2 * dock.gutter)}px`);
    canvas.dataset.mandalaColumns = current.showMandalaColumns ? 'visible' : 'hidden';
    const panel = dock.rail;
    const left = `${panel.x}px`;
    for (const element of panels) {
      element.style.left = left;
      element.style.top = `${panel.y}px`;
      element.style.width = `${panel.width}px`;
      element.style.height = `${panel.height}px`;
      element.style.setProperty('--rail-left', left);
      element.style.setProperty('--rail-top', `${panel.y}px`);
    }
    if (drawing) {
      // The small control surface covers only its own footprint. A footer-wide
      // clip would unnecessarily erase the zoomed drawing on either side.
      // The canvas's existing drawer clip remains responsible for side drawers.
      drawing.style.clipPath = 'none';
    }
    environment.refresh();
    return current;
  }
  refresh();
  return {
    get returnsLayout() { return studio.dataset.returnsLayout; },
    get sideInsets() { return { ...sideInsets }; },
    setSidePanels(getter: () => SidePanels | null) { sidePanels = getter; },
    get phone() { return phone(); },
    get showMandalaColumns() { return current.showMandalaColumns; },
    get mandalaTop() { return current.center.y - current.mandalaRadius; },
    frame() { return footprint.frame; },
    refresh,
    setTimelineKind(kind: TimelineKind) {
      if (timelineKind === kind) return false;
      timelineKind = kind;
      return true;
    },
    readViewport: environment.read,
    destroy() { environment.destroy(); viewportSubscribers.clear(); },
    subscribeViewport(callback: () => void) { viewportSubscribers.add(callback); return () => viewportSubscribers.delete(callback); },
    insets() { return current.insets; },
  };
}
