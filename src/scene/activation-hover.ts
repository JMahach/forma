import { ACTIVATION_HIGHLIGHT_OPACITY, PALETTE } from '../ui/chart-palette.ts';

interface Affine { a: number; b: number; c: number; d: number; e: number; f: number }
interface Box { x: number; y: number; width: number; height: number }

// Convert the target rectangle to its column's coordinates. Camera movement and
// the column's own scale cancel here; neither participates in hover state.
export function activationHoverBounds(box: Box, target: Affine, block: Affine): Box | null {
  const determinant = block.a * block.d - block.b * block.c;
  if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-12 || box.width <= 0 || box.height <= 0) return null;
  const points = [[box.x, box.y], [box.x + box.width, box.y],
    [box.x, box.y + box.height], [box.x + box.width, box.y + box.height]].map(([x, y]) => {
    const dx = target.a * x + target.c * y + target.e - block.e;
    const dy = target.b * x + target.d * y + target.f - block.f;
    return { x: (block.d * dx - block.c * dy) / determinant, y: (-block.b * dx + block.a * dy) / determinant };
  });
  const xs = points.map(point => point.x), ys = points.map(point => point.y);
  if (![...xs, ...ys].every(Number.isFinite)) return null;
  const x = Math.min(...xs), y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

// SmoothUI Fluid Hover Highlight: spring.fast (80ms, bounce 0), fade 80/60ms.
// Motion's findSpring resolves exp(-w) * (1 + w) = .001 at w below;
// its critically damped generator gives this curve, sampled for native WAAPI.
// Source: motiondivision/motion, motion-dom/src/animation/generators/spring.ts.
// Attribution and MIT notices: THIRD_PARTY_NOTICES.md.
export function activationSpringProgress(progress: number) {
  if (progress <= 0) return 0;
  if (progress >= 1) return 1;
  const elapsed = 9.233413476451586 * progress;
  return 1 - Math.exp(-elapsed) * (1 + elapsed);
}
const translate = (box: Box) => `translate(${box.x}px, ${box.y}px)`;
const sameBox = (a: Box | null, b: Box) => a?.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;

export function attachActivationHover(svg: SVGSVGElement) {
  const document = svg.ownerDocument, view = document.defaultView;
  const media = view?.matchMedia?.('(prefers-reduced-motion: reduce)');
  let target: Element | null = null, block: SVGGraphicsElement | null = null, destination: Box | null = null;
  let highlight: SVGRectElement | null = null, movement: Animation | null = null, fade: Animation | null = null;
  let disposed = false;
  const listeners: (() => void)[] = [];
  function listen(owner: EventTarget | null | undefined, event: string, handler: EventListener) {
    if (!owner?.addEventListener) return;
    owner.addEventListener(event, handler);
    listeners.push(() => owner.removeEventListener(event, handler));
  }
  function stopMovement() { movement?.cancel(); movement = null; }
  function stopFade() { fade?.cancel(); fade = null; }
  function paint(box: Box) {
    highlight!.setAttribute('width', String(box.width)); highlight!.setAttribute('height', String(box.height));
    highlight!.style.transform = translate(box);
  }
  function drawnBox(): Box {
    const result = { ...destination! }, style = view?.getComputedStyle?.(highlight!);
    const values = style?.transform.match(/[-+]?[\d.]+(?:e[-+]?\d+)?/gi)?.map(Number);
    if (style?.transform.startsWith('matrix(') && values?.length === 6) { result.x = values[4]; result.y = values[5]; }
    const width = Number.parseFloat(style?.width || ''), height = Number.parseFloat(style?.height || '');
    if (Number.isFinite(width)) result.width = width;
    if (Number.isFinite(height)) result.height = height;
    return result;
  }
  function fadeTo(opacity: number, duration: number, from: number) {
    stopFade(); highlight!.setAttribute('opacity', String(opacity));
    if (media?.matches || typeof highlight!.animate !== 'function' || from === opacity) return;
    const current = highlight!.animate([{ opacity: from }, { opacity }], { duration, easing: 'ease-in-out' });
    fade = current;
    current.onfinish = () => { if (fade === current) fade = null; current.cancel(); };
  }
  function hide(animate: boolean) {
    if (!target) return;
    const committed = target.getAttribute('aria-pressed') === 'true';
    target.removeAttribute('data-fluid-active'); target = null;
    if (highlight && destination) {
      const box = drawnBox(), opacity = Number(view?.getComputedStyle?.(highlight).opacity ?? highlight.getAttribute('opacity'));
      stopMovement(); paint(box);
      if (animate && !committed) fadeTo(0, 60, opacity);
      else { stopFade(); highlight.setAttribute('opacity', '0'); }
    }
    destination = null;
  }
  const clear = () => hide(false), leave = () => hide(true);
  function move(event: PointerEvent) {
    if (disposed) return;
    if (event.pointerType === 'touch' || event.buttons || svg.classList.contains('is-dragging')) { clear(); return; }
    const next = (event.target as Element | null)?.closest?.('.bg-activation') as SVGGraphicsElement | null;
    const parent = next?.closest('.activation-block-content') as SVGGraphicsElement | null;
    const rect = next?.querySelector('rect') as SVGRectElement | null;
    if (!next || !parent || !rect || !svg.contains(next)) { leave(); return; }
    const targetMatrix = rect.getCTM?.(), blockMatrix = parent.getCTM?.();
    if (!targetMatrix || !blockMatrix) { clear(); return; }
    const box = activationHoverBounds({ x: Number(rect.getAttribute('x') || 0), y: Number(rect.getAttribute('y') || 0),
      width: Number(rect.getAttribute('width')), height: Number(rect.getAttribute('height')) }, targetMatrix, blockMatrix);
    if (!box) { clear(); return; }
    const sameBlock = parent === block && highlight?.parentNode === parent;
    const opacity = next.getAttribute('opacity') || '1';
    // Compare owned numbers, never CSS serialization: browsers normalize transform
    // strings, which otherwise restarts travel on every move within the same cell.
    if (next === target && sameBlock && sameBox(destination, box)) {
      if (Number(highlight!.getAttribute('opacity')) !== Number(opacity)) { stopFade(); highlight!.setAttribute('opacity', opacity); }
      return;
    }
    const travelling = sameBlock && target !== null && destination !== null;
    const from = travelling ? drawnBox() : box;
    target?.removeAttribute('data-fluid-active'); stopMovement();
    if (!highlight) {
      highlight = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      for (const [key, value] of Object.entries({ class: 'activation-fluid-highlight', x: '0', y: '0',
        fill: PALETTE.halo, 'fill-opacity': String(ACTIVATION_HIGHLIGHT_OPACITY), 'pointer-events': 'none', 'aria-hidden': 'true' }))
        highlight.setAttribute(key, value);
      highlight.style.transformOrigin = '0 0';
    }
    if (!sameBlock) {
      const panel = parent.querySelector('.activation-panel');
      parent.insertBefore(highlight, panel ? panel.nextElementSibling : parent.firstChild);
    }
    target = next; block = parent; destination = box;
    target.setAttribute('data-fluid-active', 'true');
    // Real dimensions and translation keep the source's rounded corners intact.
    highlight.setAttribute('rx', rect.getAttribute('rx') || rect.getAttribute('ry') || '0');
    highlight.setAttribute('ry', rect.getAttribute('ry') || rect.getAttribute('rx') || '0');
    paint(box);
    if (!travelling) fadeTo(Number(opacity), 80, 0);
    else if (Number(highlight.getAttribute('opacity')) !== Number(opacity)) { stopFade(); highlight.setAttribute('opacity', opacity); }
    if (travelling && !sameBox(from, box) && !media?.matches && typeof highlight.animate === 'function') {
      const frames = Array.from({ length: 21 }, (_, index) => {
        const offset = index / 20, progress = activationSpringProgress(offset);
        const mix = (a: number, b: number) => a + (b - a) * progress;
        return { offset, transform: translate({ ...box, x: mix(from.x, box.x), y: mix(from.y, box.y) }),
          width: `${mix(from.width, box.width)}px`, height: `${mix(from.height, box.height)}px` };
      });
      const current = highlight.animate(frames, { duration: 80, easing: 'linear' });
      movement = current;
      current.onfinish = () => { if (movement === current) movement = null; current.cancel(); };
    }
  }
  listen(svg, 'pointermove', move as EventListener);
  listen(svg, 'pointerleave', leave);
  for (const event of ['pointerdown', 'pointercancel', 'wheel', 'focusin']) listen(svg, event, clear);
  listen(svg, 'keydown', ((event: KeyboardEvent) => { if (event.key === 'Escape') clear(); }) as EventListener);
  listen(view, 'blur', clear);
  listen(document, 'visibilitychange', () => { if (document.hidden) clear(); });
  listen(media, 'change', () => { if (media?.matches) { stopMovement(); stopFade(); } });
  return { clear, dispose() {
    if (disposed) return;
    disposed = true; target?.removeAttribute('data-fluid-active'); target = null;
    stopMovement(); stopFade(); listeners.forEach(remove => remove());
    highlight?.remove(); highlight = null; block = null; destination = null;
  } };
}
