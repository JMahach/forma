import { MOMENT_PLANETS, MOMENT_FIELDS, MOMENT_COLUMN_COUNT } from './day-packets/moment-columns.ts';

export const LIFETIME_PLANETS = MOMENT_PLANETS;
export const LIFETIME_FIELDS = MOMENT_FIELDS;
export const LIFETIME_POINT_BYTES = MOMENT_COLUMN_COUNT * 8;
export const LIFETIME_STEP_SECONDS = 600;
export const LIFETIME_FILE_VERSION = '3';
// Single UTC result contract; separate from the on-disk ten-minute grid.
export const LIFETIME_EXACT_VERSION = '1';
// Hash files in order; directories recurse in UTF-8 name byte order. Each file
// contributes root-relative name, NUL, byte length, NUL and bytes.
export const LIFETIME_PROVENANCE_INPUTS = Object.freeze(['server/python/astronomy.py', 'server/python/errors.py', 'server/python/date_limits.py', 'server/python/lifetime_file.py', 'requirements.txt', 'shared/lifetime-format.ts', 'shared/date-limits.ts', 'shared/day-packets/moment-columns.ts', 'data/ephe']);
export const LIFETIME_FILE_FORMAT = 'Float64 little-endian, sample-major; byte offset=(sample*24+column)*8';

export interface LifetimeMetadata {
  startUtc: string;
  endExclusiveUtc: string;
  stepSeconds: number;
  samples: number;
  planets: readonly string[];
  engine: string;
  calculationVersion?: string;
  cacheVersion?: string;
  ephemeris?: string;
  timezoneDatabase?: string;
  nodeModel?: string;
  zodiac?: string;
}
export interface LifetimeFileMetadata {
  version: string;
  format: string;
  columns: string[];
  sampleCount: number;
  stepSeconds: number;
  flags: number;
  engine: string;
  sha256: string;
  bytes: number;
  startUtc: string;
  endExclusiveUtc: string;
  provenance?: { version: string; calculationFingerprint: string };
  compatibility?: { version: string; change: string; calculationFingerprint: string; sha256: string };
}
