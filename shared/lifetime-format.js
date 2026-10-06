// Stored longitude order shared by archive preparation, server and browser.
// Earth and the south node are derived from Sun and the north node by +180°.
export const LIFETIME_PLANETS = Object.freeze(['sun', 'moon', 'north_node', 'mercury', 'venus', 'mars', 'jupiter', 'saturn', 'uranus', 'neptune', 'pluto']);
export const LIFETIME_STEP_SECONDS = 600;
export const LIFETIME_ARCHIVE_VERSION = '2';
// Single UTC result contract; separate from the on-disk ten-minute grid.
export const LIFETIME_EXACT_VERSION = '1';
// Provenance hashes these inputs in order; directories recurse in UTF-8 name
// byte order. Each file contributes its root-relative name, NUL, byte length,
// NUL and bytes. Include all ephemeris files: optional tables affect numbers.
export const LIFETIME_PROVENANCE_INPUTS = Object.freeze(['server/python/astronomy.py', 'server/python/errors.py', 'server/python/lifetime_archive.py', 'requirements.txt', 'shared/lifetime-format.js', 'data/ephe']);
export const LIFETIME_ARCHIVE_FORMAT = 'Float64 little-endian, planet-major; byte offset=(column*sampleCount+sample)*8';
