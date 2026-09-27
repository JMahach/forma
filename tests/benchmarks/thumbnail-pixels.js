import { renderBodygraph } from '/src/scene/bodygraph-svg.js';
import { renderChartThumbnail } from '/src/views/thumbnail.js';
import { CHART_SURFACE_RIM_WIDTH } from '/src/scene/backdrop.js';
import { CHART_BACKDROP_BOUNDS } from '/src/scene/geometry/chart-backdrop.js';
import { DEMO_CHART } from '/fixtures/demo-chart.js';
import { renderChartThumbnail as publishedThumbnail } from '/baseline/src/charts/chart-thumbnail.js';

const profileOptions = { profile: 'thumbnail', idPrefix: 'thumbnail' };
const width = 44, height = 68;
const inset = CHART_SURFACE_RIM_WIDTH / 2 + 1;
const { x, y, width: bodyWidth, height: bodyHeight } = CHART_BACKDROP_BOUNDS;
const viewBox = [x - inset, y - inset, bodyWidth + inset * 2, bodyHeight + inset * 2].join(' ');
const report = document.getElementById('report'), status = document.getElementById('status');
const verify = document.getElementById('verify'), stop = document.getElementById('stop');
let stopped = false, running = false;

function* cases() {
  // The same synthetic cases as thumbnail-profile.test.mjs, plus the existing
  // manual demonstration fixture. No saved charts or calculation API is used.
  yield ['empty', {}];
  yield ['single-source', { personality: [7, 31], design: [] }];
  yield ['dual-source', { personality: [7, 31, 37, 40], design: [7, 31, 37, 40] }];
  yield ['full', { personality: Array.from({ length: 64 }, (_, index) => index + 1), design: Array.from({ length: 64 }, (_, index) => index + 1) }];
  yield ['demo', DEMO_CHART];
  for (let code = 0; code < 256; code++) {
    const chart = { personality: [], design: [] };
    for (const [index, gate] of [20, 10, 34, 57].entries()) {
      const side = (code >> (index * 2)) & 3;
      if (side & 1) chart.personality.push(gate);
      if (side & 2) chart.design.push(gate);
    }
    yield [`integration-${code}`, chart];
  }
}
function source(markup) { return `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}">${markup}</svg>`)}`; }
async function raster(src) {
  const image = new Image(width, height);
  image.src = src;
  await image.decode();
  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  context.clearRect(0, 0, width, height);
  context.drawImage(image, 0, 0, width, height);
  return { canvas, pixels: context.getImageData(0, 0, width, height).data };
}
function compare(expected, actual) {
  let differentPixels = 0, differentBytes = 0, maxChannelDelta = 0, first = null;
  for (let pixel = 0; pixel < width * height; pixel++) {
    let different = false;
    for (let channel = 0; channel < 4; channel++) {
      const offset = pixel * 4 + channel, delta = Math.abs(expected[offset] - actual[offset]);
      if (delta) { differentBytes++; different = true; maxChannelDelta = Math.max(maxChannelDelta, delta); }
    }
    if (different) {
      differentPixels++;
      first ||= { x: pixel % width, y: Math.floor(pixel / width), expected: [...expected.slice(pixel * 4, pixel * 4 + 4)], actual: [...actual.slice(pixel * 4, pixel * 4 + 4)] };
    }
  }
  return { differentPixels, differentBytes, maxChannelDelta, first };
}
function showExample(label, rasters, differences) {
  const figure = document.createElement('figure'), caption = document.createElement('figcaption');
  caption.textContent = `${label}: прежняя / профиль / actual; различаются ${differences[0].differentPixels} / ${differences[1].differentPixels} пикселей`;
  figure.append(caption, ...rasters.map(item => item.canvas));
  document.getElementById('examples').append(figure);
}

export async function verifyThumbnailPixels() {
  if (running) return;
  running = true; stopped = false; verify.disabled = true; stop.disabled = false;
  document.getElementById('examples').replaceChildren();
  const started = performance.now();
  const result = { kind: 'thumbnail-pixels', status: 'running', width, height, tolerance: 0, channels: 'RGBA',
    reference: 'published renderChartThumbnail (read-only baseline)',
    compared: 0, expectedCases: 261, profileFailures: 0, actualFailures: 0, emptyPaintFailures: 0, examples: [] };
  try {
    for (const [label, chart] of cases()) {
      if (stopped) break;
      const [reference, profile, actual] = await Promise.all([
        raster(publishedThumbnail(chart)),
        raster(source(renderBodygraph(chart, null, profileOptions))),
        raster(renderChartThumbnail(chart)),
      ]);
      const profileDifference = compare(reference.pixels, profile.pixels), actualDifference = compare(reference.pixels, actual.pixels);
      if (profileDifference.differentPixels) result.profileFailures++;
      if (actualDifference.differentPixels) result.actualFailures++;
      if (!reference.pixels.some((value, index) => index % 4 === 3 && value !== 0)) result.emptyPaintFailures++;
      if ((profileDifference.differentPixels || actualDifference.differentPixels) && result.examples.length < 8) {
        result.examples.push({ label, profile: profileDifference, actual: actualDifference });
        showExample(label, [reference, profile, actual], [profileDifference, actualDifference]);
      } else if (label === 'demo') showExample(label, [reference, profile, actual], [profileDifference, actualDifference]);
      result.compared++;
      if (result.compared % 16 === 0) {
        status.textContent = `${result.compared}/${result.expectedCases}; различий ${result.profileFailures + result.actualFailures}`;
        report.textContent = JSON.stringify(result, null, 2);
        await new Promise(resolve => requestAnimationFrame(resolve));
      }
    }
    result.status = stopped ? 'stopped' : result.profileFailures || result.actualFailures || result.emptyPaintFailures ? 'failed' : 'passed';
  } catch (error) { result.status = 'error'; result.error = error.stack; }
  finally {
    result.elapsedMs = Math.round(performance.now() - started);
    report.textContent = JSON.stringify(result, null, 2); report.dataset.status = result.status;
    status.textContent = `${result.status}: ${result.compared} карт`;
    running = false; verify.disabled = false; stop.disabled = true;
  }
  return result;
}
verify.addEventListener('click', verifyThumbnailPixels);
stop.addEventListener('click', () => { stopped = true; });
