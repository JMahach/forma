// Floating caption only: the drawing's composition and camera do not depend on
// this placement. Navigation takes precedence when the full text cannot fit.
export function createChartHeadingLayout({ header, title, subtitle, leftControls, rightControls, canvas,
  gap = 8, edgePadding = 16, textPadding = 20, belowGap = 7,
  getMandalaTop = () => Infinity, mandalaGap = 8,
  readStyle = element => getComputedStyle(element), ResizeObserver = globalThis.ResizeObserver }) {
  let current;
  const visibleRect = (element, ignoreVisibility = false) => {
    if (!element || element.hidden || !element.getClientRects().length) return null;
    const style = readStyle(element);
    if (style.display === 'none' || !ignoreVisibility && style.visibility === 'hidden') return null;
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 ? rect : null;
  };
  const setStyle = (name, value) => {
    const next = `${value}px`;
    if (header.style.getPropertyValue(name) !== next) header.style.setProperty(name, next);
  };
  function refresh() {
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
    const textWidth = Math.max(title.scrollWidth, subtitle?.scrollWidth || 0) + textPadding;
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
    observer?.observe(element);
  }
  refresh();
  return { refresh, destroy() { observer?.disconnect(); } };
}
