import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { brotliCompress, constants, gzip } from 'node:zlib';

const brotli = promisify(brotliCompress), gzipAsync = promisify(gzip);
const tag = bytes => `"${createHash('sha256').update(bytes).digest('base64url')}"`;

// Only the HTTP allowlist calls this cache. Development files are revalidated
// on disk; release files and their prebuilt encodings are immutable per process.
export function createStaticAssets(root, { precompressed = false, transform = (_entry, bytes) => bytes } = {}) {
  const cache = new Map();
  return {
    async get(entry) {
      const filename = path.join(root, entry.file);
      const stat = precompressed ? null : await fs.stat(filename);
      const version = stat ? `${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}` : 'release';
      if (cache.get(entry.file)?.version === version) return cache.get(entry.file).promise;
      const promise = (async () => {
        const source = await fs.readFile(filename);
        const identity = transform(entry, source);
        // Runtime page settings may change HTML. All representations must then
        // describe those same bytes; untouched release assets keep their sidecars.
        const [br, gz] = precompressed && identity.equals(source)
          ? await Promise.all([fs.readFile(path.join(root, entry.br)), fs.readFile(path.join(root, entry.gzip))])
          : await Promise.all([brotli(identity, { params: { [constants.BROTLI_PARAM_QUALITY]: 6 } }), gzipAsync(identity)]);
        const bytes = { identity, br, gzip: gz };
        return { file: entry.file, bytes, etags: Object.fromEntries(Object.entries(bytes).map(([name, value]) => [name, tag(value)])) };
      })();
      cache.set(entry.file, { version, promise });
      try { return await promise; }
      catch (error) { if (cache.get(entry.file)?.promise === promise) cache.delete(entry.file); throw error; }
    },
  };
}
