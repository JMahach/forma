import test from 'node:test';
import assert from 'node:assert/strict';
import { isDevelopmentPort } from '../shared/development.ts';
import { readModuleSource } from './helpers/module-source.ts';

test('only the two assigned ports enable development tools', () => {
  for (const port of ['36', '3636']) assert.equal(isDevelopmentPort(port), true);
  for (const port of ['', '80', '443', '8080', '3637', '136', '3600']) assert.equal(isDevelopmentPort(port), false);
});

test('shared-chart study enters its DOM setup only on assigned development ports', () => {
  const code = readModuleSource(new URL('../src/dev/shared-chart-preview.ts', import.meta.url))
    .replace(/^import[^\n]*\n/gm, '').replace(/^export /gm, '');
  for (const port of ['36', '3636', '', '80', '443', '8080']) {
    let lookups = 0;
    new Function('location', 'document', 'isDevelopmentPort', code)({ port }, {
      querySelector(selector: string) { assert.equal(selector, '#summaryChartCaption .summary-moment-heading'); lookups++; return null; },
    }, isDevelopmentPort);
    assert.equal(lookups, isDevelopmentPort(port) ? 1 : 0, `port ${port || 'default'}`);
  }
});
