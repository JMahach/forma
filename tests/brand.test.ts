import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { LOTUS_SILHOUETTE_PATH, LOTUS_BACKDROP_BOUNDS } from '../src/scene/geometry/lotus-backdrop.ts';

const page = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const favicon = readFileSync(new URL('../public/favicon.svg', import.meta.url), 'utf8');
const paths = (svg: string) => [...svg.matchAll(/<path\b[^>]*\bd="([^"]+)"[^>]*>/g)];

test('the local browser tab uses the requested Forma 1 label and a versioned SVG favicon', () => {
  // The real release build test separately verifies the canonical published name.
  assert.deepEqual([...page.matchAll(/<title>([^<]+)<\/title>/g)].map(match => match[1]), ['Форма 1']);
  const href = page.match(/<link rel="icon"[^>]*href="([^"]+)"/)?.[1];
  assert.ok(href);
  assert.match(href, /^\/favicon\.svg\?v=forma-lotus-\d+$/);
  assert.equal(new URL(href, 'http://localhost').pathname, '/favicon.svg');
  const server = readFileSync(new URL('../server/http/app.ts', import.meta.url), 'utf8');
  assert.match(server, /publicFiles\(req, res, url\.pathname\)/, 'cache version never becomes part of the public filename');
});

test('favicon uses the actual silhouette with a solid clay fill and darker rim', () => {
  for (const svg of [favicon]) {
    const drawing = paths(svg);
    assert.equal(drawing.length, 1, 'one continuous outline, no obsolete diamond or inner mesh');
    assert.equal(drawing[0][1], LOTUS_SILHOUETTE_PATH);
    assert.match(drawing[0][0], /fill-rule="evenodd"/);
    assert.match(drawing[0][0], /stroke="#8f5d40"/);
    assert.match(drawing[0][0], /stroke-linejoin="round"/);
    assert.match(svg, /fill="#b77b55"/);
    assert.doesNotMatch(svg, /fill="none"|opacity|[Gg]radient|currentColor|<style|<filter|<image|<script|@media|#49443d|#e7dcc9/);
    const fill = svg.match(/fill="#([a-f0-9]{6})"/)![1];
    const stroke = svg.match(/stroke="#([a-f0-9]{6})"/)![1];
    for (const offset of [0, 2, 4] as const) assert.ok(parseInt(stroke.slice(offset, offset + 2), 16) < parseInt(fill.slice(offset, offset + 2), 16), 'every rim color channel is darker than the clay fill');
  }
  assert.match(page, /<div class="site-brand" aria-label="Форма"><span>Форма<\/span><\/div>/, 'the accepted menu heading uses the plain product name');
});

test('the tiny favicon has an even, unclipped stroke at sixteen and thirty-two pixels', () => {
  const [x, y, width, height] = favicon.match(/viewBox="([^"]+)"/)![1].split(' ').map(Number);
  const stroke = Number(favicon.match(/stroke-width="([^"]+)"/)![1]);
  const bounds = LOTUS_BACKDROP_BOUNDS;
  assert.equal(width, height);
  assert.equal(x + width / 2, bounds.x + bounds.width / 2);
  assert.equal(y + height / 2, bounds.y + bounds.height / 2);
  assert.ok(bounds.x - stroke / 2 > x);
  assert.ok(bounds.y - stroke / 2 > y);
  assert.ok(bounds.x + bounds.width + stroke / 2 < x + width);
  assert.ok(bounds.y + bounds.height + stroke / 2 < y + height);
  for (const size of [16, 32] as const) {
    const drawnStroke = stroke * size / width;
    assert.ok(drawnStroke >= .9 && drawnStroke < 2, `${size}px outline remains visible without filling in the shape`);
  }
});
