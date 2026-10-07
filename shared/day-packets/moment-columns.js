// Numeric moment contract shared by day packets and the lifetime file.
// Earth and the south node are derived from Sun and the north node by +180°.
export const MOMENT_PLANETS = Object.freeze(['sun', 'moon', 'north_node', 'mercury', 'venus', 'mars', 'jupiter', 'saturn', 'uranus', 'neptune', 'pluto']);
export const PERSONALITY_COLUMN = 0;
export const DESIGN_COLUMN = MOMENT_PLANETS.length;
export const DESIGN_UNIX_SECONDS_COLUMN = DESIGN_COLUMN + MOMENT_PLANETS.length;
export const DESIGN_RESIDUAL_COLUMN = DESIGN_UNIX_SECONDS_COLUMN + 1;
export const MOMENT_COLUMN_COUNT = DESIGN_RESIDUAL_COLUMN + 1;
export const MOMENT_FIELDS = Object.freeze([
  ...MOMENT_PLANETS.map(planet => `personality.${planet}`),
  ...MOMENT_PLANETS.map(planet => `design.${planet}`),
  'exactDesignUnixSeconds', 'designArcResidualDegrees',
]);
export const validMomentValue = (value, column = PERSONALITY_COLUMN) => Number.isFinite(value)
  && (column < DESIGN_UNIX_SECONDS_COLUMN ? value >= 0 && value < 360
    : column === DESIGN_UNIX_SECONDS_COLUMN ? Number.isInteger(value) && value > -10_000_000_000 && value < 20_000_000_000
      : column === DESIGN_RESIDUAL_COLUMN && value >= 0 && value <= 1e-7);
