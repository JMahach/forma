import test from 'node:test';
import assert from 'node:assert/strict';

import { createChartPreview } from '../src/views/chart-preview-canvas.ts';
import type { ChartView } from '../src/domain/chart-composition.ts';

function harness({ pixelRatio = 2, context = true, failPaint = false } = {}) {
  const images: { src: string; onload: null; onerror: null; removeAttribute(name: unknown): void; }[] = [], paints = [];
  const drawing = { drawImage(...args) { if (failPaint) throw new Error('Paint failed'); paints.push(args); } };
  const canvas = { style: {} as unknown as CSSStyleDeclaration, width: 300, height: 150,
    ownerDocument: { defaultView: { devicePixelRatio: pixelRatio } },
    getContext: (kind: unknown) => { assert.equal(kind, '2d'); return context ? drawing : null; } };
  const createImage = () => {
    const image = { src: '', onload: null, onerror: null,
      removeAttribute(name: unknown) { assert.equal(name, 'src'); this.src = ''; } };
    images.push(image);
    return image;
  };
  function start(chart: ChartView, options = {}) {
    return createChartPreview(canvas, chart, { createImage, ...options });
  }
  return { canvas, images, paints, start };
}
const svgSource = (image: { src: string; }) => decodeURIComponent(image.src.slice(image.src.indexOf(',') + 1));
const chart = Object.freeze({ personality: Object.freeze([7, 31]), design: Object.freeze([37, 40]),
  name: 'Stored chart', source: 'manual' as const });

test('preview paints the saved chart at the actual screen density without clipping its Head or silhouette', () => {
  const { canvas, images, paints, start } = harness({ pixelRatio: 2.5 });
  const dispose = start(chart);
  assert.equal(canvas.style.width, '92px');
  assert.equal(canvas.style.height, '120px');
  assert.equal(canvas.width, 230);
  assert.equal(canvas.height, 300);
  const image = images[0], source = svgSource(image);
  assert.match(source, /<svg[^>]*width="230"[^>]*height="300"/);
  assert.match(source, /data-type="center" data-id="throat"[^>]*data-defined="true"/);
  assert.match(source, /data-type="center" data-id="heart"[^>]*data-defined="true"/);
  assert.doesNotMatch(source, /tabindex=|data-activation=|class="bodygraph-gates"/);
  const [x, y, width, height] = source.match(/viewBox="([^"]+)"/)![1].split(' ').map(Number);
  assert.ok(x <= 76 && x + width >= 564, 'all 480 units of the silhouette and its six-unit rim fit');
  assert.ok(y <= 36 && y + height >= 774, 'Head at y40 and silhouette at y770 have room for strokes');
  assert.equal(paints.length, 0, 'raster painting waits for image readiness');
  image.onload!();
  assert.deepEqual(paints[0], [image, 0, 0, 230, 300]);
  assert.equal(image.src, '', 'decoded SVG source is released after painting');
  assert.equal(image.onload, null);
  assert.equal(image.onerror, null);
  assert.equal(canvas.width, 230, 'pixels remain available while visible');
  dispose();
  assert.equal(canvas.width, 0);
  assert.equal(canvas.height, 0);
});

test('disposing an image in flight releases its memory and prevents a late load from painting', () => {
  const { canvas, images, paints, start } = harness();
  const dispose = start(chart), image = images[0], lateLoad = image.onload;
  dispose();
  dispose();
  assert.equal(image.src, '');
  assert.equal(image.onload, null);
  assert.equal(image.onerror, null);
  assert.equal(canvas.width, 0);
  assert.equal(canvas.height, 0);
  lateLoad!();
  assert.equal(paints.length, 0);
});

test('a failed SVG load releases both source and canvas storage', () => {
  const { canvas, images, paints, start } = harness();
  start(chart);
  const image = images[0], lateLoad = image.onload;
  image.onerror!(new Error('decode failed'));
  assert.equal(image.src, '');
  assert.equal(canvas.width, 0);
  assert.equal(canvas.height, 0);
  lateLoad!();
  assert.equal(paints.length, 0);
});

test('re-entering the visible area renders current activations and an old load cannot replace them', () => {
  const { images, paints, start } = harness();
  const dispose = start(chart), lateLoad = images[0].onload;
  dispose();
  const close = start({ ...chart, personality: [], design: [] });
  assert.match(svgSource(images[1]), /data-type="center" data-id="throat"[^>]*data-defined="false"/);
  lateLoad!();
  images[1].onload!();
  assert.equal(paints.length, 1);
  assert.equal(paints[0][0], images[1]);
  close();
});

test('invalid display density uses a finite raster and unavailable canvas allocates no image', () => {
  for (const pixelRatio of [undefined, 0, NaN, Infinity, -1] as const) {
    const { canvas, start } = harness();
    const dispose = start(chart, { pixelRatio });
    assert.ok(canvas.width > 0 && Number.isFinite(canvas.width));
    assert.ok(canvas.height > 0 && Number.isFinite(canvas.height));
    dispose();
  }
  const { canvas, images, start } = harness({ context: false });
  const dispose = start(chart);
  assert.equal(images.length, 0);
  assert.equal(canvas.width, 0);
  assert.equal(canvas.height, 0);
  dispose();
});


test('preview readiness reports success once only after pixels are drawn', () => {
  const h = harness(), ready: unknown[] = [];
  const dispose = h.start(chart, { onReady: value => ready.push({ value, paints: h.paints.length }) });
  assert.deepEqual(ready, []);
  h.images[0].onload!();
  assert.deepEqual(ready, [{ value: true, paints: 1 }]);
  dispose();
  assert.deepEqual(ready, [{ value: true, paints: 1 }], 'disposing completed pixels cannot revise an accepted result');
});

for (const failure of ['dispose', 'decode', 'paint', 'context', 'image creation'] as const) {
  test(`preview readiness settles failure once on ${failure}`, () => {
    const h = harness({ context: failure !== 'context', failPaint: failure === 'paint' }), ready: unknown[] = [];
    const dispose = h.start(chart, { onReady: (value: unknown) => ready.push(value),
      ...(failure === 'image creation' ? { createImage() { throw new Error('Image unavailable'); } } : {}) });
    const image = h.images[0], lateLoad = image?.onload;
    if (failure === 'dispose') dispose();
    else if (failure === 'decode') image.onerror!();
    else if (failure === 'paint') image.onload!();
    assert.deepEqual(ready, [false]);
    dispose(); lateLoad?.();
    assert.deepEqual(ready, [false]);
    assert.equal(h.paints.length, 0);
  });
}
