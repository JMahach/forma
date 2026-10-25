import { GATE_MARKER } from './geometry/drawing-presentation.ts';

type InkBounds = Pick<TextMetrics, 'actualBoundingBoxLeft' | 'actualBoundingBoxRight' | 'actualBoundingBoxAscent' | 'actualBoundingBoxDescent'>;
type LabelContext = { font: string; textAlign: string; textBaseline: string; measureText: (text: string) => InkBounds };

// Measure once per created figure, never during hover/selection updates.
// Ink bounds center the visible numeral, not its font's advance or line box.
export function createGateLabelRenderer(context: LabelContext | null = typeof document === 'undefined'
  ? null : document.createElement?.('canvas')?.getContext?.('2d') ?? null) {
  if (context) {
    context.font = `${GATE_MARKER.fontWeight} ${GATE_MARKER.fontSize}px ${GATE_MARKER.fontFamily}`;
    context.textAlign = 'left';
    context.textBaseline = 'alphabetic';
  }
  return (id: number, fill: string) => {
    const bounds = context?.measureText(String(id));
    const measured = bounds && Number.isFinite(bounds.actualBoundingBoxLeft) && Number.isFinite(bounds.actualBoundingBoxRight)
      && Number.isFinite(bounds.actualBoundingBoxAscent) && Number.isFinite(bounds.actualBoundingBoxDescent);
    const x = measured ? (bounds.actualBoundingBoxLeft - bounds.actualBoundingBoxRight) / 2 : 0;
    const y = measured ? (bounds.actualBoundingBoxAscent - bounds.actualBoundingBoxDescent) / 2 : GATE_MARKER.fontSize * .35;
    return `<text x="${Number(x.toFixed(3))}" y="${Number(y.toFixed(3))}" text-anchor="${measured ? 'start' : 'middle'}" font-family="${GATE_MARKER.fontFamily}" font-size="${GATE_MARKER.fontSize}" font-weight="${GATE_MARKER.fontWeight}" fill="${fill}" pointer-events="none">${id}</text>`;
  };
}
