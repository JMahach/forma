import { setAttribute, svgNodes } from './svg-patches.ts';
// SmoothUI FluidHoverHighlight, lengthened by the requested 15%, no overshoot.
export const SOFT_HIGHLIGHT_DURATION = Object.freeze({ enter: 92, exit: 69 });
// Only currently running paint is retained; finished effects release themselves.
const running = new WeakMap<Element, Animation>();
export function canSoften(node: Element) {
  return typeof node.animate === 'function' && Boolean(node.ownerDocument.defaultView)
    && !node.ownerDocument.defaultView!.matchMedia('(prefers-reduced-motion: reduce)').matches;
}
export function softHighlightOpacity(node: Element | null, opacity: number, from?: string) {
  if (!node) return;
  const target = String(opacity);
  if (from === undefined && node.getAttribute('opacity') === target) return;
  const enabled = canSoften(node);
  const current = from ?? (enabled ? node.ownerDocument.defaultView!.getComputedStyle(node).opacity : target);
  running.get(node)?.cancel();
  running.delete(node);
  setAttribute(node, 'opacity', target);
  if (!enabled || current === target) return;
  const animation = node.animate([{ opacity: current }, { opacity: target }], { duration: opacity ? SOFT_HIGHLIGHT_DURATION.enter : SOFT_HIGHLIGHT_DURATION.exit, easing: 'ease-out' });
  running.set(node, animation);
  animation.onfinish = () => { if (running.get(node) === animation) running.delete(node); animation.cancel(); };
}

// Ordinary channel halves have finite gate ownership. Only live/outgoing paint
// occupies these slots; re-entry reclaims an exiting node rather than flashing.
export function softHighlightFragment(parent: Element, before: Node, initial: ChildNode[], initialMarkup?: string) {
  let previous = initialMarkup;
  let softened = false;
  type Entry = { node: Element; animation?: Animation; exiting?: boolean };
  const entries = new Map<string, Entry>();
  for (const node of initial) if (node.nodeType === 1) entries.set((node as Element).getAttribute('data-highlight-gate')!, { node: node as Element });
  function animate(entry: Entry, from: string, target: string, remove?: () => void) {
    entry.animation?.cancel();
    const animation = entry.node.animate([{ opacity: from }, { opacity: target }], { duration: target === '1' ? SOFT_HIGHLIGHT_DURATION.enter : SOFT_HIGHLIGHT_DURATION.exit, easing: 'ease-out' });
    entry.animation = animation;
    animation.onfinish = () => {
      if (entry.animation !== animation) return;
      entry.animation = undefined;
      remove?.(); animation.cancel();
    };
  }
  return (markup: string) => {
    const enabled = canSoften(parent);
    for (const [key, entry] of entries) if (entry.node.parentNode !== parent) { entry.animation?.cancel(); entries.delete(key); }
    if (markup === previous && enabled === softened) return false;
    previous = markup; softened = enabled;
    const desired = new Set<string>();
    for (const child of svgNodes(parent, markup)) {
      if (child.nodeType !== 1) continue;
      const candidate = child as Element, key = candidate.getAttribute('data-highlight-gate')!;
      desired.add(key);
      let entry = entries.get(key);
      if (!entry) {
        parent.insertBefore(candidate, before);
        entry = { node: candidate }; entries.set(key, entry);
        if (enabled) animate(entry, '0', '1');
      } else if (entry.exiting && enabled) {
        const opacity = parent.ownerDocument.defaultView!.getComputedStyle(entry.node).opacity;
        animate(entry, opacity, '1');
      }
      // Retain the live node while restoring the static renderer's paint order.
      parent.insertBefore(entry.node, before);
      entry.exiting = false;
      entry.node.removeAttribute('data-soft-highlight-outgoing');
      if (!enabled) { entry.animation?.cancel(); entry.animation = undefined; }
    }
    for (const [key, entry] of entries) if (!desired.has(key)) {
      if (!enabled) { entry.animation?.cancel(); entry.node.remove(); entries.delete(key); }
      else if (!entry.exiting) {
        entry.exiting = true; entry.node.setAttribute('data-soft-highlight-outgoing', 'half');
        const opacity = parent.ownerDocument.defaultView!.getComputedStyle(entry.node).opacity;
        animate(entry, opacity, '0', () => { entry.node.remove(); entries.delete(key); });
      }
    }
    return true;
  };
}

export function observeSoftHighlightMotion(root: Element) {
  const media = root.ownerDocument.defaultView?.matchMedia('(prefers-reduced-motion: reduce)');
  if (!media?.addEventListener) return () => {};
  const contours = '.bg-gate-highlight, .bg-gate-glow, .bg-center-highlight, .bg-channel-highlight, .bg-integration-hover, .bg-integration-focus, .bg-integration-selection, [data-highlight-gate], [data-soft-highlight-outgoing]';
  function settle() {
    for (const animation of root.getAnimations({ subtree: true })) {
      const target = (animation.effect as KeyframeEffect | null)?.target;
      if (target && 'matches' in target && target.matches(contours)) {
        animation.cancel(); running.delete(target as Element);
      }
    }
    for (const node of root.querySelectorAll('[data-soft-highlight-outgoing]')) node.remove();
  }
  const change = () => { if (media!.matches) settle(); };
  media.addEventListener('change', change);
  return () => { media.removeEventListener('change', change); settle(); };
}
