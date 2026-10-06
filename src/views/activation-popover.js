import { primaryChart } from '../domain/chart-composition.js';
import { resolveOverlayActivation, OVERLAY_PALETTE } from '../domain/chart-overlay.js';
import { activationDetails } from './activation-details.js';
import { escapeHtml as esc } from '../ui/html.js';

const clamp = (value, low, high) => Math.max(low, Math.min(high, value));

// Screen-space placement keeps text readable while the SVG camera moves.
export function placeActivationPopover(anchor, size, viewport, source) {
  const margin = 12, gap = source === 'design' ? 14 : 12;
  const minX = viewport.left + margin, minY = viewport.top + margin;
  const maxX = viewport.left + viewport.width - margin - size.width;
  const maxY = viewport.top + viewport.height - margin - size.height;
  const middleX = (anchor.left + anchor.right) / 2;
  const middleY = (anchor.top + anchor.bottom) / 2;
  const fitsRight = anchor.right + gap <= maxX;
  const fitsLeft = anchor.left - gap - size.width >= minX;
  let side = source === 'design' ? 'left' : 'right';
  if (side === 'right' && !fitsRight) side = fitsLeft ? 'left' : 'bottom';
  if (side === 'left' && !fitsLeft) side = fitsRight ? 'right' : 'bottom';
  if (side === 'bottom' && anchor.bottom + gap > maxY && anchor.top - gap - size.height >= minY) side = 'top';
  const horizontal = side === 'left' || side === 'right';
  const left = clamp(horizontal ? side === 'left' ? anchor.left - gap - size.width : anchor.right + gap : middleX - size.width / 2, minX, maxX);
  const top = clamp(horizontal ? middleY - size.height / 2 : side === 'top' ? anchor.top - gap - size.height : anchor.bottom + gap, minY, maxY);
  const arrow = clamp(horizontal ? middleY - top : middleX - left, 15, (horizontal ? size.height : size.width) - 15);
  return { left, top, side, arrow };
}

export function attachActivationPopover(panel, svg) {
  let currentId = null, maxHeight = null, arrowOffset = null;
  const anchor = () => currentId ? svg.querySelector(`[data-activation="${currentId}"]`) : null;
  const overlayId = () => /^(natal|cycle)-/.test(currentId || '');
  const sideSource = () => currentId?.startsWith('natal-') ? 'design' : currentId?.startsWith('cycle-') ? 'personality' : currentId?.split('-')[0];
  const positionAnchor = () => currentId?.startsWith('design-')
    ? svg.querySelector(`[data-activation="${currentId}-planet"]`) || anchor() : anchor();
  function close(restoreFocus = false) {
    const previous = anchor();
    previous?.removeAttribute('aria-describedby');
    currentId = null;
    panel.hidden = true;
    if (restoreFocus) previous?.focus({ preventScroll: true });
  }
  function reposition() {
    if (!currentId || panel.hidden) return;
    const target = positionAnchor();
    if (!target) { close(); return; }
    const targetRect = target.getBoundingClientRect();
    const triggerRect = currentId.startsWith('design-') ? anchor()?.getBoundingClientRect() : null;
    // Red normally points left from the planet. If it must flip right, clear
    // the adjacent number too, keeping that trigger available for a second tap.
    const rect = { left: targetRect.left, right: Math.max(targetRect.right, triggerRect?.right ?? targetRect.right), top: targetRect.top, bottom: targetRect.bottom };
    const visual = window.visualViewport;
    const viewport = { left: visual?.offsetLeft || 0, top: visual?.offsetTop || 0, width: visual?.width || window.innerWidth, height: visual?.height || window.innerHeight };
    if (rect.right <= viewport.left || rect.left >= viewport.left + viewport.width || rect.bottom <= viewport.top || rect.top >= viewport.top + viewport.height) { close(); return; }
    const width = `${Math.max(0, viewport.width - 24)}px`, height = `${Math.max(0, viewport.height - 24)}px`;
    if (panel.style.maxWidth !== width) panel.style.maxWidth = width;
    if (maxHeight !== height) { panel.style.setProperty('--popover-max-height', height); maxHeight = height; }
    const size = panel.getBoundingClientRect();
    const position = placeActivationPopover(rect, size, viewport, sideSource());
    // A fixed origin plus 2D translation moves the popup without changing its
    // layout coordinates. Keep actual measurements and unrounded CSS pixels.
    const transform = `translate(${position.left}px, ${position.top}px)`;
    if (panel.style.transform !== transform) panel.style.transform = transform;
    if (arrowOffset !== position.arrow) { panel.style.setProperty('--arrow-offset', `${position.arrow}px`); arrowOffset = position.arrow; }
    if (panel.dataset.side !== position.side) panel.dataset.side = position.side;
  }
  function refresh(chart) {
    if (!currentId) return;
    const [source, planet] = currentId.split('-');
    const owner = primaryChart(chart);
    const entries = owner.planetFilter
      ? source === 'design' ? owner.planetFilter.designActivations : owner.planetFilter.activations
      : owner.activations?.[source];
    const provenance = resolveOverlayActivation(chart, currentId);
    const entry = overlayId() ? provenance?.entry : owner.source === 'manual' ? null : entries?.find(item => item.planet === planet);
    const rows = activationDetails(entry);
    if (!rows || !anchor()) { close(); return; }
    panel.innerHTML = `${provenance ? `<p class="cycle-activation-caption"><span class="cycle-activation-swatch" style="--cycle-source-color:${OVERLAY_PALETTE[provenance.origin]}" aria-hidden="true"></span>${esc(provenance.label)}</p>` : ''}<div class="activation-detail-content">${rows.map(row => `<div class="activation-detail-row"><span class="activation-detail-label">${row.label}</span><span class="activation-detail-value">${row.value}</span><span class="activation-detail-meter" aria-hidden="true"><i style="width:${row.percent}%"></i></span><span class="activation-detail-percent">${row.percent.toFixed(2)}%</span></div>`).join('')}</div>`;
    panel.hidden = false;
    anchor().setAttribute('aria-describedby', panel.id);
    reposition();
  }
  function show(chart, id) {
    close();
    // IDs are a source and a known planetary key, never arbitrary selectors.
    if (!/^(?:(?:natal|cycle)-)?(design|personality)-(sun|earth|moon|north_node|south_node|mercury|venus|mars|jupiter|saturn|uranus|neptune|pluto)$/.test(id)) return;
    currentId = id;
    refresh(chart);
  }
  document.addEventListener('pointerdown', event => {
    if (!currentId || panel.contains(event.target) || event.target.closest?.('[data-activation]')?.dataset.activation === currentId) return;
    close();
  }, true);
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && currentId) { close(true); event.preventDefault(); }
  });
  window.addEventListener('resize', reposition);
  window.visualViewport?.addEventListener('resize', reposition);
  window.visualViewport?.addEventListener('scroll', reposition);
  return { show, close, refresh, reposition, get currentId() { return currentId; } };
}
