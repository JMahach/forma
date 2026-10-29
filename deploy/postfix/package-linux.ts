import { build } from 'esbuild';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

// A service installation artifact, not a second checkout or a website release.
// Bundle the existing owners: never duplicate the account schema or mail policy.
const { values } = parseArgs({ options: { output: { type: 'string' } } });
if (!values.output || !path.isAbsolute(values.output)) throw new Error('Provide a new absolute --output directory');
const root = fileURLToPath(new URL('../../', import.meta.url));
const output = values.output;
await mkdir(output, { mode: 0o700 });
const manifest: string[] = [];
async function save(name: string, bytes: Uint8Array) {
  const target = path.join(output, name);
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  await writeFile(target, bytes, { mode: 0o600, flag: 'wx' });
  manifest.push(`${createHash('sha256').update(bytes).digest('hex')}  ${name}`);
}
for (const entry of ['deploy/prepare-accounts', 'deploy/postfix/prepare']) {
  const result = await build({ absWorkingDir: root, entryPoints: [`${entry}.ts`], bundle: true,
    platform: 'node', format: 'esm', target: 'node24', write: false,
    banner: { js: "import {createRequire as createBundleRequire} from 'node:module';const require=createBundleRequire(import.meta.url);" } });
  await save(`${entry}.mjs`, result.outputFiles[0]!.contents);
}
for (const name of ['install.py', 'control.py', 'receipt.py']) {
  await save(`deploy/postfix/${name}`, await readFile(new URL(name, import.meta.url)));
}
await save('README.md', await readFile(path.join(root, 'README.md')));
await writeFile(path.join(output, 'SHA256SUMS'), manifest.join('\n') + '\n', { mode: 0o600, flag: 'wx' });
console.log(`Prepared mail-only installation package: ${output}. No services, DNS or emails changed.`);
