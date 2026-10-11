// A reviewed source-only change, not a general acceptance of older calculators.
// Keep the generating provenance intact; compatibility attests these exact inputs.
export const LIFETIME_DATE_LIMITS_MIGRATION = Object.freeze({
  change: 'shared-date-limits',
  from: '03fe75bc83b639e306ee871ad8ca8fe309dc363baa61b5d15b1391a06f19fb8f',
  to: '6c0389dc0e59b6a40ba14ac2cdb5ae05e562dc4c47bcd9b29ef2e95cc884c672',
});

export function lifetimeProvenanceMatches(metadata, currentFingerprint) {
  const provenance = metadata.provenance;
  if (provenance?.version !== '1' || typeof provenance.calculationFingerprint !== 'string') return false;
  if (provenance.calculationFingerprint === currentFingerprint) return true;
  const compatibility = metadata.compatibility, migration = LIFETIME_DATE_LIMITS_MIGRATION;
  return provenance.calculationFingerprint === migration.from && currentFingerprint === migration.to
    && compatibility?.version === '1' && compatibility.change === migration.change
    && compatibility.calculationFingerprint === currentFingerprint && compatibility.sha256 === metadata.sha256;
}
