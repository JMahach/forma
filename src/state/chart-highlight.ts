import type { HighlightStyle } from '../scene/geometry/drawing-presentation.ts';

// Current presentation only: changing it never alters a chart or its selection.
export function createChartHighlight() {
  let current: HighlightStyle = 'glow';
  const listeners = new Set<(style: HighlightStyle) => void>();
  return {
    get current() { return current; },
    set(value: unknown) {
      if ((value !== 'glow' && value !== 'outline') || value === current) return;
      current = value;
      listeners.forEach(listener => listener(current));
    },
    subscribe(listener: (style: HighlightStyle) => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}
export const chartHighlight = createChartHighlight();
