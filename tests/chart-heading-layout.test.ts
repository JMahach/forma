import test from 'node:test';
import assert from 'node:assert/strict';
import { createChartHeadingLayout } from '../src/ui/layout/chart-heading.ts';
import { readFileSync } from 'node:fs';

function harness({ width = 1002, textWidth = 240, titleWidth = 57, buttons = 3, origin = 0, mandalaTop = Infinity, fonts, withPanelCaption = false, withComparison = false, withClocks = false, withUtc = false } = {}) {
  const observed = new Map();
  let resized, disconnected = false;
  const node = (left: number, top: number, width: number, height: number) => {
    const styles = new Map();
    return {
      rect: { left, top, width, height }, hidden: false, dataset: {} as DOMStringMap, scrollWidth: 0,
      computed: { display: 'block', visibility: 'visible' },
      style: { getPropertyValue: name => styles.get(name), setProperty: (name, value) => styles.set(name, value) },
      getClientRects() { return this.hidden || this.computed.display === 'none' ? [] : [this.getBoundingClientRect()]; },
      getBoundingClientRect() { return { ...this.rect, right: this.rect.left + this.rect.width, bottom: this.rect.top + this.rect.height }; },
    };
  };
  const canvas = node(origin, 100, width, 817);
  const header = node(origin + width / 2, 119, 200, 51);
  header.ownerDocument = { fonts };
  const headerRect = header.getBoundingClientRect.bind(header);
  header.getBoundingClientRect = () => {
    const rect = headerRect();
    const top = header.dataset.captionPlacement === 'below'
      ? canvas.rect.top + parseFloat(header.style.getPropertyValue('--caption-below-top'))
      : rect.top;
    return { ...rect, top, bottom: top + rect.height };
  };
  const title = node(0, 0, 60, 22), subtitle = node(0, 0, 240, 16);
  const content = node(0, 0, 260, 51);
  Object.assign(content.computed, { paddingLeft: '10px', paddingRight: '10px' });
  title.scrollWidth = titleWidth;
  subtitle.scrollWidth = textWidth;
  const leftControls = node(origin + 16, 114, 44, 44);
  const rightControls = node(0, 114, 0, 44);
  const setButtons = (count: number) => {
    rightControls.rect.width = count * 44 + Math.max(0, count - 1) * 8;
    rightControls.rect.left = canvas.rect.left + canvas.rect.width - 16 - rightControls.rect.width;
  };
  setButtons(buttons);
  class Observer {
    constructor(callback) { resized = callback; }
    observe(element, options) { observed.set(element, options); }
    disconnect() { disconnected = true; }
  }
  const comparison = withComparison ? { root: Object.assign(node(0, 0, 296.8, 96), { hidden: true }),
    title: node(0, 0, 240, 30), date: node(0, 0, 240, 18), details: node(0, 0, 240, 30), clock: withClocks ? node(0, 0, 52, 20) : undefined } : undefined;
  const panelCaption = withPanelCaption ? { root: node(0, 0, 296.8, 96), comparison, utc: withUtc ? node(0, 0, 60, 16) : undefined,
    title: node(0, 0, 240, 30), date: node(0, 0, 240, 18), details: node(0, 0, 240, 30), clock: withClocks ? node(0, 0, 52, 20) : undefined, surface: node(0, 0, width, 817) } : undefined;
  const layout = createChartHeadingLayout({ header, content, title, subtitle, leftControls, rightControls, canvas, panelCaption,
    getMandalaTop: () => mandalaTop,
    readStyle: element => element.computed, ResizeObserver: Observer });
  return { layout, header, content, title, subtitle, leftControls, rightControls, canvas, panelCaption, setButtons, observed,
    setMandalaTop(value: number) { mandalaTop = value; },
    changePadding(left: string, right: string) {
      Object.assign(content.computed, { paddingLeft: left, paddingRight: right });
      // Padding changes the border box while fit-content text keeps its size.
      if (observed.get(content)?.box === 'border-box') resized([{ target: content }]);
    },
    resize() { resized(); }, get disconnected() { return disconnected; } };
}

test('a transit caption with minute stays above at both reported desktop widths', () => {
  for (const width of [1002, 967] as const) {
    const { header, layout } = harness({ width });
    assert.equal(header.dataset.captionPlacement, 'top');
    assert.ok(layout.refresh()!.width >= 260);
  }
});

test('caption placement follows the actual horizontal padding when its styling changes', () => {
  const h = harness({ width: 576, textWidth: 200 });
  assert.equal(h.header.dataset.captionPlacement, 'top');
  h.changePadding('10.25px', '22px');
  assert.equal(h.header.dataset.captionPlacement, 'below', 'the padded caption exceeds the 232px gap between controls');
  h.changePadding('0px', '0px');
  assert.equal(h.header.dataset.captionPlacement, 'top', 'removing padding makes the caption fit again');
});

test('unchanged caption text causes no DOM writes or layout reads while a new minute is measured', () => {
  const h = harness();
  let writes = 0, reads = 0;
  for (const element of [h.title, h.subtitle] as const) {
    let text = '';
    Object.defineProperty(element, 'textContent', { get: () => text, set: value => { text = value; writes++; } });
  }
  const measure = h.canvas.getBoundingClientRect.bind(h.canvas);
  h.canvas.getBoundingClientRect = () => { reads++; return measure(); };
  h.layout.updateText('Транзит', '29 сентября · 12:00');
  assert.equal(writes, 2);
  assert.equal(reads, 1);
  for (let index = 0; index < 120; index++) h.layout.updateText('Транзит', '29 сентября · 12:00');
  assert.equal(writes, 2);
  assert.equal(reads, 1);
  h.layout.updateText('Транзит', '29 сентября · 12:01');
  assert.equal(writes, 3, 'only the changed subtitle is written');
  assert.equal(reads, 2);
  h.canvas.rect.width = 390;
  h.resize();
  assert.equal(h.header.dataset.captionPlacement, 'below', 'unchanged text still follows viewport changes');
  assert.equal(writes, 3);
});

test('new font metrics are measured even with unchanged text and the listener is disposed', () => {
  const listeners = new Map();
  const fonts = {
    addEventListener(type, listener) { listeners.set(type, listener); },
    removeEventListener(type, listener) { if (listeners.get(type) === listener) listeners.delete(type); },
  };
  const h = harness({ fonts });
  h.layout.updateText('Транзит', '29 сентября · 12:00');
  assert.equal(h.header.dataset.captionPlacement, 'top');
  h.subtitle.scrollWidth = 1100;
  listeners.get('loadingdone')();
  assert.equal(h.header.dataset.captionPlacement, 'below');
  h.layout.destroy();
  assert.equal(listeners.size, 0);
});

test('a phone moves its caption below the real button row and uses the full centered width', () => {
  for (const width of [320, 393, 502] as const) {
    const { header, layout } = harness({ width, buttons: 4 });
    assert.deepEqual(layout.refresh(), { placement: 'below', width: width - 32, belowTop: 65 });
    assert.equal(header.style.getPropertyValue('--caption-width'), `${width - 32}px`);
    assert.equal(header.style.getPropertyValue('--caption-below-top'), '65px');
    assert.equal(header.style.getPropertyValue('left'), undefined, 'the controller never moves the horizontal center');
  }
});

test('caption goes below exactly when its intrinsic text and backing do not fit', () => {
  const h = harness({ width: 967 });
  const available = h.layout.refresh()!.width;
  h.subtitle.scrollWidth = available - 20;
  assert.equal(h.layout.refresh()!.placement, 'top');
  h.subtitle.scrollWidth += 1;
  assert.equal(h.layout.refresh()!.placement, 'below');
  h.subtitle.scrollWidth -= 1;
  assert.equal(h.layout.refresh()!.placement, 'top');
});

test('a changed name or minute is measured again without a viewport resize', () => {
  const h = harness({ width: 967 });
  h.title.scrollWidth = 1100;
  assert.equal(h.layout.refresh()!.placement, 'below', 'long natal name receives the lower row');
  assert.equal(h.layout.refresh()!.width, 935, 'only screen edges limit long text');
  h.title.scrollWidth = 57;
  h.subtitle.scrollWidth = 270;
  assert.equal(h.layout.refresh()!.placement, 'top', 'returning to transit restores the upper row');
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
  for (const element of [h.header, h.title, h.subtitle, h.leftControls, h.rightControls, h.canvas] as const) {
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
  assert.equal(h.layout.refresh()!.belowTop, 96);
  assert.equal(h.layout.refresh()!.width, 470);
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
  assert.ok(h.layout.refresh()!.width >= h.subtitle.scrollWidth + 20);
});

test('a lowered caption needs eight pixels of clear space above the mandala', () => {
  for (const gap of [-4, 0, 7, 8, 9] as const) {
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
  assert.equal(h.layout.refresh()!.placement, 'below');
});

test('invisible navigation does not reserve space and observers can be disposed', () => {
  const h = harness({ width: 502 });
  assert.equal(h.header.dataset.captionPlacement, 'below');
  h.rightControls.computed.visibility = 'hidden';
  assert.equal(h.layout.refresh()!.placement, 'top');
  h.rightControls.computed.visibility = 'visible';
  assert.equal(h.layout.refresh()!.placement, 'below');
  h.rightControls.hidden = true;
  assert.equal(h.layout.refresh()!.placement, 'top');
  h.layout.destroy();
  assert.equal(h.disconnected, true);
});


test('the panel caption mirrors the canonical title and every moment part without changing the original caption', () => {
  const h = harness({ withPanelCaption: true });
  const subtitle = '1 января 2000 г. · 12:00 · UTC+3 · Москва · 26 лет';
  h.panelCaption!.title.scrollWidth = 500;
  h.layout.updateText('Мария', subtitle);
  assert.equal(h.title.textContent, 'Мария');
  assert.equal(h.subtitle.textContent, subtitle);
  assert.equal(h.panelCaption!.title.textContent, 'Мария');
  assert.equal(h.panelCaption!.title.title, 'Мария', 'the full name remains available when CSS truncates the visible heading');
  assert.equal(h.panelCaption!.date.textContent, '1 января 2000 г.');
  assert.equal(h.panelCaption!.details.textContent, '12:00 · UTC+3 · Москва · 26 лет');
  h.layout.updateText('Без времени', '1 января 2000 г.');
  assert.equal(h.panelCaption!.date.textContent, '1 января 2000 г.');
  assert.equal(h.panelCaption!.details.textContent, '', 'previous moment details cannot remain on another chart');
  h.layout.updateText(null, undefined);
  for (const element of [h.title, h.subtitle, h.panelCaption!.title, h.panelCaption!.date, h.panelCaption!.details] as const)
    assert.equal(element.textContent, '', 'clearing the canonical caption also clears its mirror');
});

test('unchanged mirrored captions perform no text writes, height writes or measurements', () => {
  const h = harness({ withPanelCaption: true });
  let writes = 0, reads = 0, heightWrites = 0, titleWrites = 0;
  let fullTitle = '';
  Object.defineProperty(h.panelCaption!.title, 'title', { get: () => fullTitle, set: value => { fullTitle = value; titleWrites++; } });
  for (const element of [h.title, h.subtitle, h.panelCaption!.title, h.panelCaption!.date, h.panelCaption!.details] as const) {
    let text = '';
    Object.defineProperty(element, 'textContent', { get: () => text, set: value => { text = value; writes++; } });
  }
  const measure = h.panelCaption!.root.getBoundingClientRect.bind(h.panelCaption!.root);
  h.panelCaption!.root.getBoundingClientRect = () => { reads++; return measure(); };
  const setHeight = h.panelCaption!.surface.style.setProperty;
  h.panelCaption!.surface.style.setProperty = (name, value) => { heightWrites++; setHeight(name, value); };
  h.layout.updateText('Транзит', '21 октября · 12:00 · UTC');
  assert.equal(writes, 5);
  const measured = reads;
  assert.ok(measured > 0);
  for (let index = 0; index < 120; index++) h.layout.updateText('Транзит', '21 октября · 12:00 · UTC');
  assert.equal(writes, 5);
  assert.equal(reads, measured);
  assert.equal(heightWrites, 0, 'unchanged panel height is not rewritten');
  assert.equal(titleWrites, 0, 'unchanged full-name tooltip is not rewritten');
  h.layout.updateText('Транзит', '21 октября · 12:01 · UTC');
  assert.equal(writes, 7, 'only the original subtitle and mirrored details change');
  assert.equal(titleWrites, 0, 'a new moment does not rewrite the full-name tooltip');
  assert.equal(heightWrites, 0);
});

test('the panel height follows its own observer while zoom hides the central caption', () => {
  const h = harness({ withPanelCaption: true });
  assert.ok(h.observed.has(h.panelCaption!.root), 'panel wrapping must be observed independently');
  assert.equal(h.panelCaption!.surface.style.getPropertyValue('--summary-caption-height'), '96px');
  h.header.hidden = true;
  h.panelCaption!.root.computed.visibility = 'hidden';
  h.panelCaption!.root.rect.height = 124;
  h.canvas.getBoundingClientRect = () => { throw new Error('zoomed central caption must keep its existing early return'); };
  h.resize();
  assert.equal(h.panelCaption!.surface.style.getPropertyValue('--summary-caption-height'), '124px');
  h.layout.updateText('Длинное имя', '21 октября · 12:01 · UTC');
  assert.equal(h.panelCaption!.title.textContent, 'Длинное имя');
  h.panelCaption!.root.rect.width = 0;
  h.panelCaption!.root.rect.height = 0;
  h.resize();
  assert.equal(h.panelCaption!.surface.style.getPropertyValue('--summary-caption-height'), '124px', 'a hidden desktop panel cannot overwrite its last measured height with zero');
});


test('a pair projects each source into its own panel row without replacing the combined central caption', () => {
  const h = harness({ withPanelCaption: true, withComparison: true });
  const panel = h.panelCaption!, comparison = panel.comparison!;
  const title = 'Анна · Возврат Сатурна 1';
  const subtitle = '8 октября 2026 г. · 12:25:37 · UTC+3 · 28 лет';
  h.layout.updateText(title, subtitle, [
    { title: 'Анна', subtitle: '18 августа 1998 г. · 18:00 · UTC+4 · Мурманск' },
    { title: 'Возврат Сатурна 1', subtitle },
  ]);
  assert.equal(h.title.textContent, title);
  assert.equal(h.subtitle.textContent, subtitle);
  assert.equal(panel.title.textContent, 'Анна');
  assert.equal(panel.date.textContent, '18 августа 1998 г.');
  assert.equal(panel.details.textContent, '18:00 · UTC+4 · Мурманск');
  assert.equal(comparison.root.hidden, false);
  assert.equal(comparison.title.textContent, 'Возврат Сатурна 1');
  assert.equal(comparison.title.title, '', 'a visible title is not duplicated');
  assert.equal(comparison.date.textContent, '8 октября 2026 г.');
  assert.equal(comparison.details.textContent, '12:25:37 · UTC+3 · 28 лет');
});

test('returning from a pair to one moment hides and clears every comparison field', () => {
  const h = harness({ withPanelCaption: true, withComparison: true });
  const panel = h.panelCaption!, comparison = panel.comparison!;
  h.layout.updateText('Анна · Транзит', '8 октября · 12:25 · UTC+3', [
    { title: 'Анна', subtitle: '18 августа · 18:00 · UTC+4' },
    { title: 'Транзит', subtitle: '8 октября · 12:25 · UTC+3' },
  ]);
  h.layout.updateText('Транзит', '9 октября · 12:30 · UTC', [
    { title: 'Транзит', subtitle: '9 октября · 12:30 · UTC' },
  ]);
  assert.equal(comparison.root.hidden, true);
  for (const element of [comparison.title, comparison.date, comparison.details]) assert.equal(element.textContent, '');
  assert.equal(comparison.title.title, '', 'the former event name cannot survive as a tooltip');
  assert.equal(panel.title.textContent, 'Транзит');
  assert.equal(panel.date.textContent, '9 октября');
  assert.equal(panel.details.textContent, '12:30 · UTC');
  assert.equal(h.title.textContent, 'Транзит');
  assert.equal(h.subtitle.textContent, '9 октября · 12:30 · UTC');
});

test('unchanged pair values avoid repeated text, tooltip, visibility writes and measurements', () => {
  const h = harness({ withPanelCaption: true, withComparison: true });
  const panel = h.panelCaption!, comparison = panel.comparison!;
  const counts = { text: 0, tooltip: 0, hidden: 0, measure: 0 };
  for (const element of [h.title, h.subtitle, panel.title, panel.date, panel.details,
    comparison.title, comparison.date, comparison.details]) {
    let text = '';
    Object.defineProperty(element, 'textContent', { get: () => text, set: value => { text = value; counts.text++; } });
  }
  for (const element of [panel.title, comparison.title]) {
    let title = '';
    Object.defineProperty(element, 'title', { get: () => title, set: value => { title = value; counts.tooltip++; } });
  }
  let hidden = true;
  Object.defineProperty(comparison.root, 'hidden', { get: () => hidden, set: value => { hidden = value; counts.hidden++; } });
  const measure = panel.root.getBoundingClientRect.bind(panel.root);
  panel.root.getBoundingClientRect = () => { counts.measure++; return measure(); };
  const pair = [
    { title: 'Анна', subtitle: '18 августа · 18:00 · UTC+4' },
    { title: 'Транзит', subtitle: '8 октября · 12:25 · UTC+3' },
  ];
  h.layout.updateText('Анна · Транзит', '8 октября · 12:25 · UTC+3', pair);
  assert.equal(counts.text, 8);
  assert.equal(counts.tooltip, 0);
  assert.equal(counts.hidden, 1);
  assert.ok(counts.measure > 0);
  const first = { ...counts };
  for (let index = 0; index < 120; index++) {
    h.layout.updateText('Анна · Транзит', '8 октября · 12:25 · UTC+3', pair.map(moment => ({ ...moment })));
  }
  assert.deepEqual(counts, first, 'equal values need no projection even when the caller supplies new objects');
});

test('the shared summary heading owns the only caption and its comparison action in the initial page', () => {
  const page = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const heading = page.match(/<header class="summary-heading">([\s\S]*?)<\/header>/)?.[1];
  assert.ok(heading, 'the same panel heading is present before viewport initialization');
  for (const id of ['summaryChartCaption', 'summaryChartTitle', 'summaryComparison', 'summaryBreakComparison']) {
    assert.match(heading, new RegExp(`id="${id}"`));
    assert.equal([...page.matchAll(new RegExp(`id="${id}"`, 'g'))].length, 1, `${id} has a single owner on every screen width`);
  }
  const comparisonStart = heading.indexOf('id="summaryComparison"');
  const action = heading.indexOf('id="summaryBreakComparison"');
  const secondTitle = heading.indexOf('id="summaryComparisonTitle"');
  assert.ok(comparisonStart < action && action < secondTitle, 'the comparison action belongs to the hidden second-moment block');
  assert.match(heading.slice(comparisonStart, action), /hidden>/);
});


test('clock fields keep the same meaning across single, paired and cleared headings', () => {
  const h = harness({ withPanelCaption: true, withComparison: true, withClocks: true });
  const primary = { title: 'Анна', subtitle: '1 января 2000 г. · 12:00 · UTC+3 · Москва' };
  h.layout.updateText(primary.title, primary.subtitle, [primary]);
  assert.equal(h.panelCaption!.clock!.textContent, '12:00 · UTC+3');
  assert.equal(h.panelCaption!.details.textContent, 'Москва', 'clock is never buried in the secondary text');
  const comparison = { title: 'Возврат Сатурна 1', subtitle: '21 июля 2028 г. · 12:13:49 · UTC+3 · 28 лет' };
  h.layout.updateText(primary.title, primary.subtitle, [primary, comparison]);
  assert.equal(h.panelCaption!.clock!.textContent, '12:00 · UTC+3');
  assert.equal(h.panelCaption!.comparison!.clock!.textContent, '12:13:49 · UTC+3');
  h.layout.updateText(primary.title, primary.subtitle, [primary]);
  assert.equal(h.panelCaption!.clock!.textContent, '12:00 · UTC+3');
  assert.equal(h.panelCaption!.comparison!.clock!.textContent, '');
  h.layout.updateText('Без времени', '1 января 2000 г. · Москва');
  assert.equal(h.panelCaption!.clock!.textContent, '');
  assert.equal(h.panelCaption!.details.textContent, 'Москва', 'a place cannot be mistaken for a clock');
});


test('heading emphasis retains zero, fractional and historical UTC offsets', () => {
  const h = harness({ withPanelCaption: true, withClocks: true });
  for (const zone of ['UTC', 'UTC-3:30', 'UTC+5:45', 'UTC+3:30:12', 'UTC−0:25:21']) {
    h.layout.updateText('Анна', `1 января 1900 г. · 12:00 · ${zone} · Москва`);
    assert.equal(h.panelCaption!.clock!.textContent, `12:00 · ${zone}`);
    assert.equal(h.panelCaption!.details.textContent, 'Москва');
  }
});

test('single-card UTC separates without losing precision and pair transition restores the old clock', () => {
  const h = harness({ withPanelCaption: true, withComparison: true, withClocks: true, withUtc: true });
  const primary = { title: 'Анна', subtitle: '1 января 2000 г. · 04:20:31 · UTC+3:25:45 · Москва · 26 лет' };
  h.layout.updateText(primary.title, primary.subtitle, [primary]);
  assert.equal(h.panelCaption!.clock!.textContent, '04:20:31');
  assert.equal(h.panelCaption!.utc!.textContent, 'UTC+3:25:45');
  assert.equal(h.panelCaption!.date.textContent, '1 января 2000');
  assert.equal(h.panelCaption!.details.textContent, 'Москва · 26 лет');
  h.layout.updateText('Пара', primary.subtitle, [primary, { title: 'Транзит', subtitle: '22 октября 2026 г. · 12:00 · UTC' }]);
  assert.equal(h.panelCaption!.clock!.textContent, '04:20:31 · UTC+3:25:45');
  assert.equal(h.panelCaption!.utc!.textContent, '');
  assert.equal(h.panelCaption!.date.textContent, '1 января 2000 г.');
  h.layout.updateText('Без времени', '1 января 2000 г. · Москва');
  assert.equal(h.panelCaption!.clock!.textContent, '');
  assert.equal(h.panelCaption!.utc!.textContent, '');
});

test('full caption appears as a native hint only while its text is clipped', () => {
  const h=harness({withPanelCaption:true}); const title=h.panelCaption!.title;
  h.layout.updateText('Длинное имя карты','Сегодня');
  assert.equal(title.title,'');
  title.scrollWidth=500; h.resize(); assert.equal(title.title,'Длинное имя карты');
  title.rect.width=600; h.resize(); assert.equal(title.title,'');
});
