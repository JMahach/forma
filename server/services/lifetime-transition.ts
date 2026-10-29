import fs from 'node:fs/promises';
import type {Stats} from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {migrateLifetimeFileMetadata} from '../../shared/calculation-storage-transition.ts';
import {readLifetimeMetadata, validateLifetimeMetadata, verifyLifetimeDigest} from './lifetime.ts';

const sameFile = (before:Stats, after:Stats) =>
  (['dev','ino','size','mtimeMs','ctimeMs'] as const).every(key => before[key] === after[key]);

async function writeMetadata(file:string, content:unknown, original:Stats) {
  const handle = await fs.open(file, 'wx', 0o600);
  try {
    await handle.writeFile(JSON.stringify(content, null, 2) + '\n');
    const created = await handle.stat();
    if (created.uid !== original.uid || created.gid !== original.gid) await handle.chown(original.uid, original.gid);
    await handle.chmod(original.mode & 0o777);
    await handle.sync();
  } finally {await handle.close();}
}

async function syncDirectory(file:string) {
  const handle = await fs.open(path.dirname(file), 'r');
  try {await handle.sync();} finally {await handle.close();}
}

/** Explicit deployment transition, not a read-time repair. The numeric file is
 * immutable; only complete verified metadata is atomically published. An
 * interrupted publication leaves old or new metadata, both retryable. */
export async function migratePreparedLifetimeFile({file, metadataFile}:{file:string; metadataFile:string}) {
  const {stat:metadataStat, raw:original, input:source} = await readLifetimeMetadata(metadataFile);
  const migrated = migrateLifetimeFileMetadata(source), validated = validateLifetimeMetadata(migrated);
  if (migrated === source) {
    // Also finishes durability after an interruption immediately after rename.
    await syncDirectory(metadataFile);
    return false;
  }
  const handle = await fs.open(file, 'r');
  let temporary:string|undefined;
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size !== validated.bytes) throw new TypeError('Invalid prepared numeric file');
    await verifyLifetimeDigest(handle, validated.bytes, validated.sha256);
    temporary = path.join(path.dirname(metadataFile), `${path.basename(metadataFile)}.${randomUUID()}.tmp`);
    await writeMetadata(temporary, migrated, metadataStat);
    if (!sameFile(before, await fs.stat(file)) || await fs.readFile(metadataFile, 'utf8') !== original)
      throw new Error('Prepared inputs changed during metadata transition');
    await fs.rename(temporary, metadataFile);
    temporary = undefined;
    await syncDirectory(metadataFile);
    return true;
  } finally {
    await handle.close();
    if (temporary) await fs.rm(temporary, {force:true}).catch(() => {});
  }
}
