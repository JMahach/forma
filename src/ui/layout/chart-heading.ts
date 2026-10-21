export interface PanelCaption { root: HTMLElement | null; title: HTMLElement | null; date: HTMLElement | null; details: HTMLElement | null; surface: HTMLElement | null }
export type ChartHeadingLayout = ReturnType<typeof createChartHeadingLayout>;
interface HeadingLayoutOptions {
  header: HTMLElement; content: HTMLElement; title: HTMLElement; subtitle: HTMLElement | null;
  leftControls: HTMLElement; rightControls: HTMLElement; canvas: HTMLElement; panelCaption?: PanelCaption | null;
  gap?: number; edgePadding?: number; belowGap?: number; getMandalaTop?: () => number; mandalaGap?: number;
  readStyle?: (element: Element) => CSSStyleDeclaration; ResizeObserver?: typeof globalThis.ResizeObserver;
}

// Caption placement and its panel mirror share the accepted chart text.
// Neither changes the drawing's composition or camera.
export function createChartHeadingLayout({ header, content, title, subtitle, leftControls, rightControls, canvas, panelCaption = null,
  gap = 8, edgePadding = 16, belowGap = 7,
  getMandalaTop = () => Infinity, mandalaGap = 8,
  readStyle = element => getComputedStyle(element), ResizeObserver = globalThis.ResizeObserver }: HeadingLayoutOptions) {
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
  const observer = ResizeObserver ? new ResizeObserver(refresh) : null;
  for (const element of new Set([header, title, subtitle, leftControls, rightControls, canvas].filter(Boolean))) {
    observer?.observe(element!);
  }
  // Padding may change while the fit-content text keeps the same dimensions.
  observer?.observe(content, { box: 'border-box' });
  if (panelCaption?.root) observer?.observe(panelCaption.root, { box: 'border-box' });
  const fonts = header.ownerDocument?.fonts;
  fonts?.addEventListener('loadingdone', refresh);
  function updateText(titleText: string | null | undefined, subtitleText: string | null | undefined) {
    let changed = false;
    const [date, ...details] = (subtitleText == null ? '' : String(subtitleText)).split(' · ');
    for (const [element, value] of [[title, titleText], [subtitle, subtitleText],
      [panelCaption?.title, titleText], [panelCaption?.date, date], [panelCaption?.details, details.join(' · ')]] as const) {
      if (!element) continue;
      const text = value == null ? '' : String(value);
      if (element.textContent !== text) {
        element.textContent = text;
        if (element === panelCaption?.title) element.title = text;
        changed = true;
      }
    }
    return changed ? refresh() : current;
  }
  refresh();
  return { refresh, updateText, destroy() { observer?.disconnect(); fonts?.removeEventListener('loadingdone', refresh); } };
}
