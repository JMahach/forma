import test from 'node:test';
import assert from 'node:assert/strict';
import { createChartHeadingLayout } from '../src/charts/chart-heading-layout.js';

function harness({ width = 1002, textWidth = 240, titleWidth = 57, buttons = 3, origin = 0, mandalaTop = Infinity } = {}) {
  const observed = new Set();
  let resized, disconnected = false;
  const node = (left, top, width, height) => {
    const styles = new Map();
    return {
      rect: { left, top, width, height }, hidden: false, dataset: {}, scrollWidth: 0,
      computed: { display: 'block', visibility: 'visible' },
      style: { getPropertyValue: name => styles.get(name), setProperty: (name, value) => styles.set(name, value) },
      getClientRects() { return this.hidden || this.computed.display === 'none' ? [] : [this.getBoundingClientRect()]; },
      getBoundingClientRect() { return { ...this.rect, right: this.rect.left + this.rect.width, bottom: this.rect.top + this.rect.height }; },
    };
  };
  const canvas = node(origin, 100, width, 817);
  const header = node(origin + width / 2, 119, 200, 51);
  const headerRect = header.getBoundingClientRect.bind(header);
  header.getBoundingClientRect = () => {
    const rect = headerRect();
    const top = header.dataset.captionPlacement === 'below'
      ? canvas.rect.top + parseFloat(header.style.getPropertyValue('--caption-below-top'))
      : rect.top;
    return { ...rect, top, bottom: top + rect.height };
  };
  const title = node(0, 0, 60, 22), subtitle = node(0, 0, 240, 16);
  title.scrollWidth = titleWidth;
  subtitle.scrollWidth = textWidth;
  const leftControls = node(origin + 16, 114, 44, 44);
  const rightControls = node(0, 114, 0, 44);
  const setButtons = count => {
    rightControls.rect.width = count * 44 + Math.max(0, count - 1) * 8;
    rightControls.rect.left = canvas.rect.left + canvas.rect.width - 16 - rightControls.rect.width;
  };
  setButtons(buttons);
  class Observer {
    constructor(callback) { resized = callback; }
    observe(element) { observed.add(element); }
    disconnect() { disconnected = true; }
  }
  const layout = createChartHeadingLayout({ header, title, subtitle, leftControls, rightControls, canvas,
    getMandalaTop: () => mandalaTop,
    readStyle: element => element.computed, ResizeObserver: Observer });
  return { layout, header, title, subtitle, leftControls, rightControls, canvas, setButtons, observed,
    setMandalaTop(value) { mandalaTop = value; },
    resize() { resized(); }, get disconnected() { return disconnected; } };
}

test('a transit caption with minute stays above at both reported desktop widths', () => {
  for (const width of [1002, 967]) {
    const { header, layout } = harness({ width });
    assert.equal(header.dataset.captionPlacement, 'top');
    assert.ok(layout.refresh().width >= 260);
  }
});

test('a phone moves its caption below the real button row and uses the full centered width', () => {
  for (const width of [320, 393, 502]) {
    const { header, layout } = harness({ width, buttons: 4 });
    assert.deepEqual(layout.refresh(), { placement: 'below', width: width - 32, belowTop: 65 });
    assert.equal(header.style.getPropertyValue('--caption-width'), `${width - 32}px`);
    assert.equal(header.style.getPropertyValue('--caption-below-top'), '65px');
    assert.equal(header.style.getPropertyValue('left'), undefined, 'the controller never moves the horizontal center');
  }
});

test('caption goes below exactly when its intrinsic text and backing do not fit', () => {
  const h = harness({ width: 967 });
  const available = h.layout.refresh().width;
  h.subtitle.scrollWidth = available - 20;
  assert.equal(h.layout.refresh().placement, 'top');
  h.subtitle.scrollWidth += 1;
  assert.equal(h.layout.refresh().placement, 'below');
  h.subtitle.scrollWidth -= 1;
  assert.equal(h.layout.refresh().placement, 'top');
});

test('a changed name or minute is measured again without a viewport resize', () => {
  const h = harness({ width: 967 });
  h.title.scrollWidth = 1100;
  assert.equal(h.layout.refresh().placement, 'below', 'long natal name receives the lower row');
  assert.equal(h.layout.refresh().width, 935, 'only screen edges limit long text');
  h.title.scrollWidth = 57;
  h.subtitle.scrollWidth = 270;
  assert.equal(h.layout.refresh().placement, 'top', 'returning to transit restores the upper row');
});

test('appearing navigation buttons trigger an actual fit check', () => {
  const h = harness({ width: 800, textWidth: 300 });
  assert.equal(h.header.dataset.captionPlacement, 'top');
  h.setButtons(5);
  h.resize();
  assert.equal(h.header.dataset.captionPlacement, 'below');
  h.setButtons(3);
  h.resize();
  assert.equal(h.header.dataset.captionPlacement, 'top');
  for (const element of [h.header, h.title, h.subtitle, h.leftControls, h.rightControls, h.canvas]) {
    assert.ok(h.observed.has(element));
  }
});

test('hidden captions retain placement and recompute when they become visible', () => {
  const h = harness({ width: 800 });
  const previous = h.layout.refresh();
  h.header.hidden = true;
  h.title.scrollWidth = 0;
  h.subtitle.scrollWidth = 0;
  h.setButtons(5);
  assert.equal(h.layout.refresh(), previous);
  assert.equal(h.header.dataset.captionPlacement, 'top');
  h.header.hidden = false;
  h.subtitle.scrollWidth = 300;
  h.resize();
  assert.equal(h.header.dataset.captionPlacement, 'below');
});

test('safe-area navigation height and an offset canvas are respected without touching the drawing', () => {
  const h = harness({ width: 502, origin: 120 });
  const canvasBefore = JSON.stringify(h.canvas.rect);
  h.rightControls.rect.top = 145;
  assert.equal(h.layout.refresh().belowTop, 96);
  assert.equal(h.layout.refresh().width, 470);
  assert.equal(JSON.stringify(h.canvas.rect), canvasBefore);
  assert.deepEqual(h.canvas.dataset, {});
});

test('a caption hidden below the mandala returns to the top as space becomes available', () => {
  const h = harness({ width: 502, mandalaTop: 220 });
  assert.equal(h.header.dataset.captionPlacement, 'below');
  assert.equal(h.header.dataset.mandalaOverlap, 'true');
  h.header.computed.visibility = 'hidden';
  h.canvas.rect.width = 967;
  h.setButtons(3);
  h.resize();
  assert.equal(h.header.dataset.captionPlacement, 'top');
  assert.equal(h.header.dataset.mandalaOverlap, 'false');
  assert.ok(h.layout.refresh().width >= h.subtitle.scrollWidth + 20);
});

test('a lowered caption needs eight pixels of clear space above the mandala', () => {
  for (const gap of [-4, 0, 7, 8, 9]) {
    const h = harness({ width: 502 });
    const captionBottom = h.header.getBoundingClientRect().bottom;
    assert.equal(captionBottom, 216, 'measure the final lower row in screen coordinates');
    h.setMandalaTop(captionBottom + gap);
    h.layout.refresh();
    assert.equal(h.header.dataset.mandalaOverlap, String(gap < 8), `${gap}px of space above the ring`);
  }
});

test('mandala clearance uses the applied lower position, not the previous top row', () => {
  const h = harness({ width: 967, mandalaTop: 200 });
  assert.equal(h.header.dataset.captionPlacement, 'top');
  assert.equal(h.header.dataset.mandalaOverlap, 'false');
  h.canvas.rect.width = 502;
  h.setButtons(3);
  h.resize();
  assert.equal(h.header.dataset.captionPlacement, 'below');
  assert.equal(h.header.getBoundingClientRect().bottom, 216);
  assert.equal(h.header.dataset.mandalaOverlap, 'true');
});

test('top captions remain eligible even when the ring reaches the navigation row', () => {
  const h = harness({ width: 967, mandalaTop: 0 });
  assert.equal(h.header.dataset.captionPlacement, 'top');
  assert.equal(h.header.dataset.mandalaOverlap, 'false');
});

test('a still-lowered hidden caption reappears when vertical space increases', () => {
  const h = harness({ width: 393, mandalaTop: 220 });
  assert.equal(h.header.dataset.mandalaOverlap, 'true');
  h.header.computed.visibility = 'hidden';
  for (let update = 0; update < 3; update++) {
    h.resize();
    assert.equal(h.header.dataset.mandalaOverlap, 'true', 'repeated hidden measurements retain the overlap');
  }
  h.canvas.rect.height = 1000;
  h.setMandalaTop(300);
  h.resize();
  assert.equal(h.header.dataset.captionPlacement, 'below', 'the buttons still leave insufficient horizontal space');
  assert.equal(h.header.dataset.mandalaOverlap, 'false', 'visibility hiding does not block a new clearance measurement');
  h.header.computed.visibility = 'visible';
  for (let update = 0; update < 3; update++) {
    h.resize();
    assert.equal(h.header.dataset.mandalaOverlap, 'false', 'showing the caption cannot cause a visibility loop');
  }
});

test('caption height changes update mandala clearance through the size observer', () => {
  const h = harness({ width: 502, mandalaTop: 230 });
  assert.equal(h.header.dataset.mandalaOverlap, 'false');
  h.header.rect.height += 10;
  h.resize();
  assert.equal(h.header.dataset.mandalaOverlap, 'true');
  h.header.rect.height -= 10;
  h.resize();
  assert.equal(h.header.dataset.mandalaOverlap, 'false');
});

test('a display-none or zero-size caption retains placement despite changes around it', () => {
  const h = harness({ width: 967 });
  const previous = h.layout.refresh();
  h.title.scrollWidth = 1100;
  h.header.computed.display = 'none';
  assert.equal(h.layout.refresh(), previous);
  h.header.computed.display = 'block';
  h.header.rect.width = 0;
  assert.equal(h.layout.refresh(), previous);
  h.header.rect.width = 200;
  assert.equal(h.layout.refresh().placement, 'below');
});

test('invisible navigation does not reserve space and observers can be disposed', () => {
  const h = harness({ width: 502 });
  assert.equal(h.header.dataset.captionPlacement, 'below');
  h.rightControls.computed.visibility = 'hidden';
  assert.equal(h.layout.refresh().placement, 'top');
  h.rightControls.computed.visibility = 'visible';
  assert.equal(h.layout.refresh().placement, 'below');
  h.rightControls.hidden = true;
  assert.equal(h.layout.refresh().placement, 'top');
  h.layout.destroy();
  assert.equal(h.disconnected, true);
});
