// Stored longitude order shared by archive preparation, server and browser.
// Earth and the south node are derived from Sun and the north node by +180°.
export const LIFETIME_PLANETS = Object.freeze(['sun', 'moon', 'north_node', 'mercury', 'venus', 'mars', 'jupiter', 'saturn', 'uranus', 'neptune', 'pluto']);
export const LIFETIME_STEP_SECONDS = 600;
export const LIFETIME_ARCHIVE_VERSION = '2';
export const LIFETIME_ARCHIVE_FORMAT = 'Float64 little-endian, planet-major; byte offset=(column*sampleCount+sample)*8';
