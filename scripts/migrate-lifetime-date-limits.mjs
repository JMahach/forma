// One audited migration. It never writes planetary data or accepts arbitrary revisions.
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createLifetimeFile, lifetimeFileFingerprint } from '../server/services/lifetime.mjs';
import { LIFETIME_DATE_LIMITS_MIGRATION as migration, lifetimeProvenanceMatches } from '../server/services/lifetime-compatibility.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '--file' || !args[1].endsWith('.f64le')) {
  throw new Error('Usage: node scripts/migrate-lifetime-date-limits.mjs --file /path/lifetime.f64le');
}
const file = path.resolve(args[1]), metadataFile = file.replace(/\.f64le$/, '.metadata.json');
const lockFile = metadataFile + '.migration-lock';
let lock, temporary;
try {
  lock = await fs.open(lockFile, 'wx', 0o600);
  const current = await lifetimeFileFingerprint(root);
  if (current !== migration.to) throw new Error('Current source is not the reviewed date-limit revision');
  const metaStat = await fs.stat(metadataFile);
  if (!metaStat.isFile() || metaStat.size > 16_384) throw new Error('Invalid lifetime metadata file');
  const original = await fs.readFile(metadataFile, 'utf8'), metadata = JSON.parse(original);
  if (lifetimeProvenanceMatches(metadata, current)) {
    const verified = await createLifetimeFile({ file, metadataFile, root });
    await verified.close();
    console.log(JSON.stringify({ status: 'already-compatible', file, sha256: metadata.sha256 }));
  } else {
    if (metadata.provenance?.version !== '1' || metadata.provenance.calculationFingerprint !== migration.from
        || metadata.compatibility !== undefined) throw new Error('Generating revision is not the reviewed migration source');
    const before = await fs.stat(file);
    metadata.compatibility = { version: '1', change: migration.change, calculationFingerprint: current, sha256: metadata.sha256 };
    temporary = metadataFile + '.' + randomUUID() + '.tmp';
    const handle = await fs.open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(JSON.stringify(metadata, null, 2) + '\n');
      const created = await handle.stat();
      if (created.uid !== metaStat.uid || created.gid !== metaStat.gid) await handle.chown(metaStat.uid, metaStat.gid);
      await handle.chmod(metaStat.mode & 0o777);
      await handle.sync();
    }
    finally { await handle.close(); }
    // Reuse all runtime schema, interval, length and whole-file checksum checks.
    const verified = await createLifetimeFile({ file, metadataFile: temporary, root });
    await verified.close();
    const after = await fs.stat(file);
    if (['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'].some(key => before[key] !== after[key])
        || await fs.readFile(metadataFile, 'utf8') !== original
        || await lifetimeFileFingerprint(root) !== current) throw new Error('Inputs changed during compatibility verification');
    await fs.rename(temporary, metadataFile);
    temporary = null;
    console.log(JSON.stringify({ status: 'migrated', file, sha256: metadata.sha256, originalProvenancePreserved: true }));
  }
} finally {
  if (temporary) await fs.unlink(temporary).catch(() => {});
  if (lock) { await lock.close(); await fs.unlink(lockFile); }
}
