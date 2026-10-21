import type { CameraFrame } from './geometry/frames.ts';
import type { Point } from './camera.ts';
export interface FitInsets { side?: number; top?: number; bottom?: number; offsetY?: number }

// A deterministic conversion of viewport insets into a camera fitting area.
// `project` converts a CSS-pixel point through the measured SVG screen matrix.
export function computeCameraFit(frame: CameraFrame, rect: Pick<DOMRect, "left" | "right" | "top" | "bottom" | "width" | "height">, insets: FitInsets | null | undefined, project: (x: number, y: number) => Point) {
  const { bounds, minScale } = frame, flexible = Boolean(insets) || minScale < .65;
  const side = Math.min(insets?.side ?? (rect.width < 700 ? 22 : 64), flexible ? rect.width / 4 : Infinity);
  const topInset = Math.min(insets?.top ?? (rect.width < 700 ? 128 : 86), flexible ? rect.height * (insets ? .49 : .3) : Infinity);
  const bottomInset = Math.min(insets?.bottom ?? 72, flexible ? rect.height * (insets ? .49 : .2) : Infinity);
  const offsetY = insets?.offsetY ?? 0;
  const top = project(rect.left + side, rect.top + topInset + offsetY);
  const bottom = project(rect.right - side, rect.bottom - bottomInset + offsetY);
  const area = { x: top.x, y: top.y, width: Math.max(flexible ? 1 : 100, bottom.x - top.x), height: Math.max(flexible ? 1 : 100, bottom.y - top.y) };
  const min = flexible ? Math.min(minScale, area.width / bounds.width, area.height / bounds.height) : minScale;
  // Navigation includes the full fixed surface, including its white margins.
  // Fitting insets only position the drawing within that field.
  const first = project(rect.left, rect.top), last = project(rect.right, rect.bottom);
  const viewport = { x: first.x, y: first.y, width: last.x - first.x, height: last.y - first.y };
  return { area, min, viewport, screenScale: rect.width / viewport.width };
}
