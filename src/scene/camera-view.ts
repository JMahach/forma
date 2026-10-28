import type { CameraFrame } from './geometry/frames.ts';
import type { CameraPosition } from './camera.ts';
import type { FitInsets } from './camera-fit.ts';

import { computeCameraFit } from './camera-fit.ts';

// The fixed surface owns input coordinates and clipping; its SVG fills the box
// without borders or padding. Moving the SVG never changes the camera's ruler.
export function createCameraView({ svg, surface, referenceSurface = surface, mirrors = [] }: { svg: SVGSVGElement; surface: HTMLElement | SVGSVGElement; referenceSurface?: HTMLElement | SVGSVGElement; mirrors?: SVGSVGElement[] }) {
  const drawings = [svg, ...mirrors];
  for (const drawing of drawings) {
    drawing.style.transformOrigin = '0 0';
    drawing.style.transformBox = 'border-box';
  }
  let lastTransform: string | null = null, revealed = false;

  function projection(rect = surface.getBoundingClientRect()) {
    const box = svg.viewBox.baseVal;
    const aspect = svg.preserveAspectRatio.baseVal;
    let sx = rect.width / box.width, sy = rect.height / box.height;
    let ox = -box.x * sx, oy = -box.y * sy;
    if (aspect.align !== 1) {
      sx = sy = aspect.meetOrSlice === 2 ? Math.max(sx, sy) : Math.min(sx, sy);
      const alignment = aspect.align - 2;
      ox = (rect.width - box.width * sx) * ((alignment % 3) / 2) - box.x * sx;
      oy = (rect.height - box.height * sy) * (Math.floor(alignment / 3) / 2) - box.y * sy;
    }
    return { rect, sx, sy, ox, oy };
  }
  const project = ({ rect, sx, sy, ox, oy }: ReturnType<typeof projection>, x: number, y: number) => ({
    x: (x - rect.left - ox) / sx, y: (y - rect.top - oy) / sy,
  });
  return {
    surface,
    point(event: Pick<MouseEvent, "clientX" | "clientY">) { return project(projection(), event.clientX, event.clientY); },
    measureFit(frame: CameraFrame, fitInsets?: FitInsets | (() => FitInsets) | null) {
      const measured = projection();
      const insets = typeof fitInsets === 'function' ? fitInsets() : fitInsets;
      const referenceScale = referenceSurface === surface ? measured.sx
        : projection(referenceSurface.getBoundingClientRect()).sx;
      return { ...computeCameraFit(frame, measured.rect, insets, (x, y) => project(measured, x, y)),
        zoomLimitScale: referenceScale / measured.sx };
    },
    paint({ x, y, k }: CameraPosition) {
      const { sx, sy, ox, oy } = projection();
      // L maps SVG units to the fixed box; V is the logical camera. Applying
      // L*V*L^-1 to the whole SVG preserves L*V while avoiding SVG text relayout.
      // Keep the exact flat projection in a 3D-compatible matrix. Whether this
      // lets the browser reuse painted pixels needs device verification; the
      // matrix alone does not guarantee a separate composited layer.
      const transform = `matrix3d(${k}, 0, 0, 0, 0, ${k}, 0, 0, 0, 0, 1, 0, ${sx * x + (1 - k) * ox}, ${sy * y + (1 - k) * oy}, 0, 1)`;
      // CSSOM rounds serialized matrix numbers; compare authored values.
      if (lastTransform !== transform) {
        for (const drawing of drawings) drawing.style.transform = transform;
        lastTransform = transform;
      }
      if (!revealed) {
        // All mirrors use the live SVG's viewBox and full stationary surface.
        // Reveal only after the single camera has supplied their projection.
        for (const drawing of mirrors) drawing.style.visibility = 'visible';
        revealed = true;
      }
    },
  };
}
