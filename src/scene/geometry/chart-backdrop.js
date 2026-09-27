export const CHART_BACKDROP_BOUNDS = Object.freeze({ x: 80, y: 30, width: 480, height: 740 });

// Tangents join smoothly throughout. The upper section flows directly into
// broad shoulders and a rounded bowl: no pinched neck or center-shaped steps.
export const CHART_SILHOUETTE_PATH = [
  'M 320 30',
  'C 280 30 252 74 252 124',
  'C 252 184 207 249 162 338',
  'C 117 427 80 509 80 596',
  'C 80 613 80 631 80 648',
  'C 80 696 198 770 320 770',
  'C 442 770 560 696 560 648',
  'C 560 631 560 613 560 596',
  'C 560 509 523 427 478 338',
  'C 433 249 388 184 388 124',
  'C 388 74 360 30 320 30',
  'Z',
].join(' ');
