import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

// These inputs define the numbers shared by minute days and lifetime moments.
// Transport, compression, styling and file layout have their own versions.
export const CALCULATION_INPUTS = Object.freeze([
  'server/python/astronomy.py', 'server/python/civil_time.py', 'server/python/errors.py',
  'server/python/calculator.py', 'server/python/transit_day.py', 'server/python/lifetime_file.py', 'requirements.txt',
  'shared/day-packets/moment-columns.js', 'data/ephe',
]);

export async function inputFingerprint(root, names) {
  const hash = createHash('sha256');
  async function add(name) {
    const file = path.join(root, name), info = await fs.stat(file);
    if (info.isDirectory()) {
      const children = await fs.readdir(file);
      children.sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
      for (const child of children) await add(`${name}/${child}`);
    } else {
      const bytes = await fs.readFile(file);
      hash.update(`${name}\0${bytes.length}\0`).update(bytes);
    }
  }
  for (const name of names) await add(name);
  return hash.digest('hex');
}
export const calculationVersion = root => inputFingerprint(root, CALCULATION_INPUTS);
