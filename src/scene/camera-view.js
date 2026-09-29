import { computeCameraFit } from './layout.js';

// The fixed surface owns input coordinates and clipping; its SVG fills the box
// without borders or padding. Moving the SVG never changes the camera's ruler.
export function createCameraView({ svg, surface }) {
  svg.style.transformOrigin = '0 0';
  svg.style.transformBox = 'border-box';
  let lastTransform = null;

  function projection() {
    const rect = surface.getBoundingClientRect();
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
  const project = ({ rect, sx, sy, ox, oy }, x, y) => ({
    x: (x - rect.left - ox) / sx, y: (y - rect.top - oy) / sy,
  });
  return {
    surface,
    point(event) { return project(projection(), event.clientX, event.clientY); },
    measureFit(frame, fitInsets) {
      const measured = projection();
      const insets = typeof fitInsets === 'function' ? fitInsets() : fitInsets;
      return computeCameraFit(frame, measured.rect, insets, (x, y) => project(measured, x, y));
    },
    paint({ x, y, k }) {
      const { sx, sy, ox, oy } = projection();
      // L maps SVG units to the fixed box; V is the logical camera. Applying
      // L*V*L^-1 to the whole SVG preserves L*V while avoiding SVG text relayout.
      const transform = `matrix(${k}, 0, 0, ${k}, ${sx * x + (1 - k) * ox}, ${sy * y + (1 - k) * oy})`;
      // CSSOM rounds serialized matrix numbers; compare authored values.
      if (lastTransform !== transform) {
        svg.style.transform = transform;
        lastTransform = transform;
      }
    },
  };
}
