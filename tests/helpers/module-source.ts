import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';

// Source-inspection and isolated-module tests use the same erased code as the browser.
export function readModuleSource(file: URL): string {
  return stripTypeScriptTypes(readFileSync(file, 'utf8'), { mode: 'strip', sourceUrl: file.href });
}
