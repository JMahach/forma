// The HTTP response contract is independent of prepared-file provenance.
// The unused export in lifetime-format.js remains frozen at its historical value:
// changing that file would invalidate existing prepared files. Remove the old
// export only with the next disk-format version, when files must be rebuilt.
export const LIFETIME_EXACT_VERSION = '1';
