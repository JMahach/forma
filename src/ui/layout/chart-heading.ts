import { createLayoutObserver } from './resize-observer.ts';
interface CaptionMoment { title: string; subtitle: string }
interface CaptionFields { clock?: HTMLElement | null; title: HTMLElement | null; date: HTMLElement | null; details: HTMLElement | null }
export interface PanelCaption { utc?: HTMLElement | null; clock?: HTMLElement | null; comparison?: CaptionFields & { root: HTMLElement | null }; root: HTMLElement | null; title: HTMLElement | null; date: HTMLElement | null; details: HTMLElement | null; surface: HTMLElement | null }
export type ChartHeadingLayout = ReturnType<typeof createChartHeadingLayout>;
interface HeadingLayoutOptions {
  header: HTMLElement; content: HTMLElement; title: HTMLElement; subtitle: HTMLElement | null;
  leftControls: HTMLElement; rightControls: HTMLElement; canvas: HTMLElement; panelCaption?: PanelCaption | null;
  gap?: number; edgePadding?: number; belowGap?: number; getMandalaTop?: () => number; mandalaGap?: number;
  readStyle?: (element: Element) => CSSStyleDeclaration; ResizeObserver?: typeof globalThis.ResizeObserver;
  requestFrame?: (callback: FrameRequestCallback) => number; cancelFrame?: (handle: number) => void;
}

// Caption placement and its panel mirror share the accepted chart text.
// Neither changes the drawing's composition or camera.
export function createChartHeadingLayout({ header, content, title, subtitle, leftControls, rightControls, canvas, panelCaption = null,
  gap = 8, edgePadding = 16, belowGap = 7,
  getMandalaTop = () => Infinity, mandalaGap = 8,
  readStyle = element => getComputedStyle(element), ResizeObserver = globalThis.ResizeObserver,
  requestFrame, cancelFrame }: HeadingLayoutOptions) {
  let current: { placement: 'top' | 'below'; width: number; belowTop: number } | undefined;
  const visibleRect = (element: HTMLElement | null | undefined, ignoreVisibility = false) => {
    if (!element || element.hidden || !element.getClientRects().length) return null;
    const style = readStyle(element);
    if (style.display === 'none' || !ignoreVisibility && style.visibility === 'hidden') return null;
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 ? rect : null;
  };
  const setStyle = (name: string, value: number, element = header) => {
    const next = `${value}px`;
    if (element.style.getPropertyValue(name) !== next) element.style.setProperty(name, next);
  };
  function refresh() {
    for (const element of [panelCaption?.title, panelCaption?.details, panelCaption?.comparison?.title, panelCaption?.comparison?.details]) {
      if (!element) continue;
      const rect = visibleRect(element, true);
      const hint = rect && element.scrollWidth > rect.width + .5 ? element.textContent || '' : '';
      if (element.title !== hint) element.title = hint;
    }
    // The panel caption keeps its own measured height when zoom hides the
    // central caption. Visibility-hidden text still has usable geometry.
    const panelRect = visibleRect(panelCaption?.root, true);
    if (panelRect && panelCaption!.surface) setStyle('--summary-caption-height', panelRect.height, panelCaption!.surface);
    // display:none during zoom has no measurable text. A caption hidden only
    // by visibility still has geometry: measure it so resizing can restore
    // either its top placement or enough space above the mandala.
    if (!visibleRect(header, true)) return current;
    const frame = canvas.getBoundingClientRect();
    if (!(frame.width > 0)) return current;
    const left = visibleRect(leftControls), right = visibleRect(rightControls);
    const center = frame.left + frame.width / 2;
    const leftEdge = Math.max(frame.left + edgePadding, left ? left.right + gap : frame.left);
    const rightEdge = Math.min(frame.right - edgePadding, right ? right.left - gap : frame.right);
    const topWidth = Math.max(0, 2 * Math.min(center - leftEdge, rightEdge - center));
    const contentStyle = readStyle(content);
    const textWidth = Math.max(title.scrollWidth, subtitle?.scrollWidth || 0)
      + (parseFloat(contentStyle.paddingLeft) || 0) + (parseFloat(contentStyle.paddingRight) || 0);
    const placement = textWidth <= topWidth ? 'top' : 'below';
    const width = placement === 'top' ? topWidth : Math.max(0, frame.width - 2 * edgePadding);
    const belowTop = Math.max(0, (left?.bottom || frame.top) - frame.top,
      (right?.bottom || frame.top) - frame.top) + belowGap;
    current = { placement, width, belowTop };
    if (header.dataset.captionPlacement !== placement) header.dataset.captionPlacement = placement;
    setStyle('--caption-width', width);
    setStyle('--caption-below-top', belowTop);
    // Measure after placement: the caption may have just moved between rows.
    // Reserve a small gap from the full ring, including during its reveal.
    header.dataset.mandalaOverlap = String(placement === 'below'
      && header.getBoundingClientRect().bottom + mandalaGap > getMandalaTop());
    return current;
  }
  const observer = ResizeObserver ? createLayoutObserver(refresh, {Observer: ResizeObserver, requestFrame, cancelFrame}) : null;
  for (const element of new Set([header, title, subtitle, leftControls, rightControls, canvas].filter(Boolean))) {
    observer?.observe(element!);
  }
  // Padding may change while the fit-content text keeps the same dimensions.
  observer?.observe(content, { box: 'border-box' });
  if (panelCaption?.root) observer?.observe(panelCaption.root, { box: 'border-box' });
  const fonts = header.ownerDocument?.fonts;
  fonts?.addEventListener('loadingdone', refresh);
  function updateText(titleText: string | null | undefined, subtitleText: string | null | undefined, moments?: readonly CaptionMoment[]) {
    let changed = false;
    const primary = moments?.[0] || { title: titleText || '', subtitle: subtitleText || '' };
    const secondary = moments?.[1];
    const comparison = panelCaption?.comparison;
    if (comparison?.root && comparison.root.hidden === Boolean(secondary)) {
      comparison.root.hidden = !secondary; changed = true;
    }
    // Time and UTC keep one place and emphasis for a single moment and a pair.
    const fields = (caption: CaptionMoment | undefined, hasClock: boolean) => {
      const [date = '', ...parts] = (caption?.subtitle || '').split(' · ');
      const timing: string[] = [], details: string[] = [];
      for (const part of parts) {
        if (hasClock && (/^\d{1,2}:\d{2}(?::\d{2})?$/.test(part) || /^UTC(?:[+−-]\d{1,2}(?::\d{2}){0,2})?$/.test(part))) timing.push(part);
        else details.push(part);
      }
      return { date, clock: timing.join(' · '), details: details.join(' · ') };
    };
    const first = fields(primary, Boolean(panelCaption?.clock));
    const second = fields(secondary, Boolean(comparison?.clock));
    // The selected single-card layout separates time and UTC; paired moments
    // retain their existing combined clock until their design is selected.
    const separateUtc = Boolean(panelCaption?.utc && !secondary);
    const clockParts = first.clock.split(' · ');
    const primaryClock = separateUtc ? clockParts.filter(part => !part.startsWith('UTC')).join(' · ') : first.clock;
    const primaryUtc = separateUtc ? clockParts.filter(part => part.startsWith('UTC')).join(' · ') : '';
    const primaryDate = separateUtc ? first.date.replace(/ г\.$/, '') : first.date;
    for (const [element, value] of [[title, titleText], [subtitle, subtitleText],
      [panelCaption?.title, primary.title], [panelCaption?.date, primaryDate], [panelCaption?.details, first.details],
      [panelCaption?.clock, primaryClock], [panelCaption?.utc, primaryUtc],
      [comparison?.title, secondary?.title || ''], [comparison?.date, second.date], [comparison?.details, second.details],
      [comparison?.clock, second.clock]] as const) {
      if (!element) continue;
      const text = value == null ? '' : String(value);
      if (element.textContent !== text) {
        element.textContent = text;

        changed = true;
      }
    }
    return changed ? refresh() : current;
  }
  refresh();
  return { refresh, updateText, destroy() { observer?.disconnect(); fonts?.removeEventListener('loadingdone', refresh); } };
}
