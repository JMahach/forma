import revisions from '../../shared/prepared-data-revisions.json' with { type: 'json' };
import type { LifetimeFileMetadata } from '../../shared/lifetime-format.ts';
// A reviewed source-only change, not a general acceptance of older calculators.
// Keep the generating provenance intact; compatibility attests these exact inputs.
export const LIFETIME_DATE_LIMITS_MIGRATION = Object.freeze({
  change: 'shared-date-limits',
  from: '03fe75bc83b639e306ee871ad8ca8fe309dc363baa61b5d15b1391a06f19fb8f',
  to: '6c0389dc0e59b6a40ba14ac2cdb5ae05e562dc4c47bcd9b29ef2e95cc884c672',
});

// The TypeScript move changes source paths and types, not planetary numbers.
// Only this exact reviewed source pair can reuse its predecessor's data.
export function lifetimeGeneratingRevision(currentFingerprint: string) {
  const migration = revisions.lifetimeTypescript;
  return currentFingerprint === migration.to ? migration.from : currentFingerprint;
}

export function lifetimeProvenanceMatches(metadata: LifetimeFileMetadata, currentFingerprint: string) {
  const provenance = metadata.provenance;
  if (provenance?.version !== '1' || typeof provenance.calculationFingerprint !== 'string') return false;
  if (provenance.calculationFingerprint === currentFingerprint) return true;
  const generatingRevision = lifetimeGeneratingRevision(currentFingerprint);
  if (provenance.calculationFingerprint === generatingRevision) return true;
  const compatibility = metadata.compatibility, migration = LIFETIME_DATE_LIMITS_MIGRATION;
  return provenance.calculationFingerprint === migration.from && generatingRevision === migration.to
    && compatibility?.version === '1' && compatibility.change === migration.change
    && compatibility.calculationFingerprint === generatingRevision && compatibility.sha256 === metadata.sha256;
}
