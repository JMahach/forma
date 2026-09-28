import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { gzip, brotliCompress, constants } from 'node:zlib';
import { build } from 'esbuild';

const project = fileURLToPath(new URL('../', import.meta.url));
const gzipAsync = promisify(gzip), brotli = promisify(brotliCompress);

// Source remains readable and runs directly in development. Only release HTML
// refers to these content-versioned assets; the server reads one explicit map.
export async function buildWeb({ root = project, outdir = path.join(root, 'dist') } = {}) {
  const result = await build({
    absWorkingDir: root,
    entryPoints: { app: 'src/app.js', love: 'src/stories/vessel-of-love.js', styles: 'public/styles.css', 'love-style': 'public/love.css' },
    outdir, entryNames: 'assets/[name]-[hash]', chunkNames: 'assets/shared-[hash]',
    bundle: true, splitting: true, format: 'esm', platform: 'browser', target: ['safari15', 'chrome100'],
    minify: true, metafile: true, write: false, logLevel: 'silent',
  });
  const manifest = {}, outputs = new Map(result.outputFiles.map(file => [path.relative(outdir, file.path), file.contents]));
  const entryUrl = input => {
    const output = Object.entries(result.metafile.outputs).find(([, meta]) => meta.entryPoint === input)?.[0];
    if (!output) throw new Error(`Missing browser entry: ${input}`);
    return '/' + path.relative(outdir, path.resolve(root, output));
  };
  const icon = await fs.readFile(path.join(root, 'public/favicon.svg'));
  const iconFile = `assets/favicon-${createHash('sha256').update(icon).digest('hex').slice(0, 16)}.svg`;
  outputs.set(iconFile, icon);
  const shared = Object.keys(result.metafile.outputs).filter(file => /shared-[^/]+\.js$/.test(file));
  const preload = shared.map(file => `<link rel="modulepreload" href="/${path.relative(outdir, path.resolve(root, file))}">`).join('\n  ');
  for (const [page, script, style, styleEntry] of [
    ['index.html', 'src/app.js', '/styles.css', 'public/styles.css'],
    ['love.html', 'src/stories/vessel-of-love.js', '/love.css', 'public/love.css'],
  ]) {
    let html = await fs.readFile(path.join(root, 'public', page), 'utf8');
    html = html.replace(`src="/${script}"`, `src="${entryUrl(script)}"`)
      .replace(`href="${style}"`, `href="${entryUrl(styleEntry)}"`)
      .replace(/href="\/favicon\.svg(?:\?[^"]*)?"/, `href="/${iconFile}"`)
      .replace('</head>', `  ${preload}\n</head>`);
    outputs.set(page, Buffer.from(html));
  }
  for (const [file, contents] of outputs) {
    const bytes = Buffer.from(contents), filename = path.join(outdir, file);
    await fs.mkdir(path.dirname(filename), { recursive: true });
    const [gz, br] = await Promise.all([gzipAsync(bytes, { level: 9 }), brotli(bytes, { params: { [constants.BROTLI_PARAM_QUALITY]: 9 } })]);
    await Promise.all([fs.writeFile(filename, bytes), fs.writeFile(`${filename}.gz`, gz), fs.writeFile(`${filename}.br`, br)]);
    manifest[file] = { file, gzip: `${file}.gz`, br: `${file}.br`, immutable: file.startsWith('assets/') };
  }
  manifest.love = manifest['love.html'];
  await fs.writeFile(path.join(outdir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const manifest = await buildWeb();
  console.log(`Форма: подготовлено ${Object.keys(manifest).length - 1} файлов релиза в dist/`);
}
