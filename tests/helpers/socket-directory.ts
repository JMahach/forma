import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

export function socketDirectory(prefix: string) {
  // macOS's per-user temp path can exceed the Unix socket pathname limit.
  const root = process.platform === 'darwin' ? '/tmp' : tmpdir();
  return mkdtemp(path.join(root, prefix));
}
