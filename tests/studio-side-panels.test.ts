import test from 'node:test';
import assert from 'node:assert/strict';
import * as geometry from '../src/ui/layout/studio.ts';
import { createStudioLayout } from './fixtures/studio-layout.ts';

const close = (actual: number|undefined, expected: number, message: string|undefined) => assert.ok(Math.abs(actual! - expected) < 1e-8,
  `${message}: ${actual} should equal ${expected}`);

test('both panel widths reserve one shared free area or overlay it when it would be too narrow', () => {
  assert.equal(typeof geometry.computeSidePanelLayout, 'function');
  for (const [input, expected] of [
    [{ width: 1200, left: true, right: true, leftWidth: 280, rightWidth: 320 }, { mode: 'side', left: 280, right: 320, width: 600 }],
    [{ width: 920, left: true, right: true, leftWidth: 280, rightWidth: 320 }, { mode: 'side', left: 280, right: 320, width: 320 }],
    [{ width: 919, left: true, right: true, leftWidth: 280, rightWidth: 320 }, { mode: 'overlay', left: 0, right: 0, width: 919 }],
    [{ width: 1200, phone: true, left: true, right: true, leftWidth: 280, rightWidth: 320 }, { mode: 'overlay', left: 0, right: 0, width: 1200 }],
    [{ width: 800, left: false, right: true, leftWidth: 280, rightWidth: 320 }, { mode: 'side', left: 0, right: 320, width: 480 }],
    [{ width: 800 }, { mode: 'side', left: 0, right: 0, width: 800 }],
  ] as const) assert.deepEqual(geometry.computeSidePanelLayout(input), expected);
});

test('the backing, rail, dates and transit action share the free area in every side-panel state', () => {
  const properties = new Map();
  const full = { left: 75, width: 1400, height: 900 };
  const state = { left: true, right: true, leftWidth: 280, rightWidth: 320 };
  const media = { matches: false };
  const studio = { dataset: {} as DOMStringMap, style: { setProperty: (name, value) => properties.set(name, value) }, getBoundingClientRect: () => full };
  const canvas = { dataset: {} as DOMStringMap, parentElement: studio, getBoundingClientRect() {
    assert.ok(properties.has('--studio-left-space') && properties.has('--studio-right-space'), 'side CSS is applied before measuring the canvas');
    return { left: full.left + parseFloat(properties.get('--studio-left-space')), width: full.width - parseFloat(properties.get('--studio-left-space')) - parseFloat(properties.get('--studio-right-space')), height: full.height };
  } };
  const rail = { style: { setProperty() {} } as unknown as CSSStyleDeclaration };
  const layout = createStudioLayout({ canvas, panels: [rail], media, viewport: null, sidePanels: () => state,
    readStyle: () => ({ scrollPaddingTop: '112px', scrollPaddingLeft: '4px', getPropertyValue: () => '0px' }) });
  assert.deepEqual(layout.sideInsets, { mode: 'side', left: 280, right: 320, width: 800 });
  close(layout.refresh().center.x, 400, 'chart center uses only its remaining 800px area');
  close(parseFloat(rail.style.left) + parseFloat(rail.style.width) / 2, 680, 'rail follows the center between unequal panels');
  let fullWindowRail;
  for (const [left, right] of [[false, false], [true, false], [false, true], [true, true]] as const) {
    Object.assign(state, { left, right });
    const home = layout.refresh();
    close(home.center.x, (1400 - (left ? 280 : 0) - (right ? 320 : 0)) / 2, 'only the chart center follows panel reservations');
    const areaLeft = left ? 280 : 0, areaWidth = 1400 - areaLeft - (right ? 320 : 0);
    close(parseFloat(rail.style.left) + parseFloat(rail.style.width) / 2, areaLeft + areaWidth / 2, 'rail is centered between the current panel edges');
    assert.ok(parseFloat(rail.style.left) >= areaLeft + 24);
    assert.ok(parseFloat(rail.style.left) + parseFloat(rail.style.width) <= areaLeft + areaWidth - 24);
    close(parseFloat(properties.get('--timeline-area-left')), areaLeft, 'backing starts at the chart edge');
    close(parseFloat(properties.get('--timeline-area-width')), areaWidth, 'backing stops at the other chart edge');
    close(parseFloat(properties.get('--timeline-content-left')), areaLeft + 24, 'transit action uses the same free area');
    close(parseFloat(properties.get('--timeline-content-width')), areaWidth - 48);
    if (!left && !right) fullWindowRail = [rail.style.left, rail.style.width, rail.style.top];
    close(parseFloat(properties.get('--timeline-dates-left')), (left ? 280 : 0) + 24, 'dates clear the actual left panel');
    close(parseFloat(properties.get('--timeline-dates-width')), 1400 - (left ? 280 : 0) - (right ? 320 : 0) - 48, 'dates stop inside the right edge of the free chart');
  }
  assert.equal(layout.returnsLayout, 'side');
  full.width = 919; layout.refresh();
  close(parseFloat(rail.style.width), 871, 'only the smaller window narrows the rail to its gutters');
  close(parseFloat(rail.style.left), 24, 'the resized rail stays centered in the full window');
  assert.equal(studio.dataset.panelsLayout, 'overlay');
  assert.equal(layout.returnsLayout, 'sheet');
  assert.deepEqual(layout.sideInsets, { mode: 'overlay', left: 0, right: 0, width: 919 });
  for (let i = 0; i < 3; i++) close(layout.refresh().center.x, 459.5, 'overlay cannot feed narrowed measurements back into the decision');
  full.width = 1400; media.matches = true; layout.refresh();
  assert.deepEqual(layout.sideInsets, { mode: 'overlay', left: 0, right: 0, width: 1400 });
  assert.deepEqual([rail.style.left, rail.style.width, rail.style.top], fullWindowRail, 'overlay mode restores the full-window rail');
  assert.equal(properties.get('--timeline-area-left'), '0px');
  assert.equal(properties.get('--timeline-area-width'), '1400px');
});

test('startup without a panel owner reserves no sides and accepts the owner later', () => {
  const properties = new Map();
  const rect = { width: 1200, height: 900 };
  const studio = { dataset: {} as DOMStringMap, style: { setProperty: (name, value) => properties.set(name, value) }, getBoundingClientRect: () => rect };
  const canvas = { dataset: {} as DOMStringMap, parentElement: studio, getBoundingClientRect: () => rect };
  const layout = createStudioLayout({ canvas, panels: [], media: { matches: false }, viewport: null,
    readStyle: () => ({ scrollPaddingTop: '112px', scrollPaddingLeft: '4px', getPropertyValue: () => '0px' }) });
  assert.deepEqual(layout.sideInsets, { mode: 'side', left: 0, right: 0, width: 1200 });
  layout.setSidePanels(() => ({ left: true, right: false, leftWidth: 280, rightWidth: 320 }));
  layout.refresh();
  assert.equal(properties.get('--studio-left-space'), '280px');
  assert.equal(properties.get('--studio-right-space'), '0px');
});


test('sibling panels end at the solid rail backing through floating dates, safe area and keyboard lift', () => {
  const properties = new Map(), shared = new Map();
  const full = { top: 0, bottom: 900, width: 390, height: 900 };
  const viewport = { height: 900, offsetTop: 0 };
  let safeBottom = 0;
  const workspace = { style: { setProperty: (name, value) => shared.set(name, value) } };
  const studio = { dataset: {} as DOMStringMap, parentElement: workspace,
    style: { setProperty: (name, value) => properties.set(name, value) }, getBoundingClientRect: () => full };
  const canvas = { dataset: {} as DOMStringMap, parentElement: studio, getBoundingClientRect: () => full };
  const layout = createStudioLayout({ canvas, panels: [], timelineKind: 'chronicle', viewport,
    media: { matches: true }, readStyle: () => ({ scrollPaddingTop: '112px', scrollPaddingLeft: '4px',
      getPropertyValue: (name: string) => name === '--timeline-safe-bottom' ? `${safeBottom}px` : '0px' }) });
  const bottom = () => parseFloat(shared.get('--timeline-panels-bottom'));
  close(bottom(), 30.6, 'both sibling panels share the solid bar edge');
  assert.ok(parseFloat(properties.get('--timeline-dock-height')) > bottom(), 'floating date row is excluded from the panel bottom');
  let seenByPopup;
  layout.subscribeViewport(() => { seenByPopup = bottom(); });
  viewport.height = 600;
  layout.refresh();
  close(bottom(), 330.6, 'keyboard lifts the panels with the solid bar');
  close(seenByPopup, 330.6, 'shared geometry is published before popup subscribers');
  safeBottom = 34;
  layout.refresh();
  close(bottom(), 364.6, 'safe area belongs to the solid backing');
  viewport.height = 900;
  layout.setTimelineKind('day');
  layout.refresh();
  close(bottom(), 64.6, 'closing keyboard and dates keeps only the solid backing');
  layout.destroy();
});


test('the entire timeline follows each measured frame while unequal side panels move', () => {
  const values = new Map(), full = { left: 73, top: 24, width: 1400, height: 900 };
  const measured = { left: full.left, width: full.width, height: full.height };
  const studio = { dataset: {} as DOMStringMap, style: { setProperty: (name, value) => values.set(name, value) }, getBoundingClientRect: () => full };
  const canvas = { dataset: {} as DOMStringMap, parentElement: studio, getBoundingClientRect: () => measured };
  const rail = { dataset: {} as DOMStringMap, style: { setProperty() {} } as unknown as CSSStyleDeclaration };
  const layout = createStudioLayout({ canvas, panels: [rail], media: { matches: false }, viewport: null,
    sidePanels: () => ({ left: true, right: true, leftWidth: 280, rightWidth: 320 }),
    readStyle: () => ({ scrollPaddingTop: '112px', scrollPaddingLeft: '4px', getPropertyValue: () => '0px' }) });
  const initialTop = rail.style.top;
  for (const opening of [true, false] as const) for (let step = 0; step <= 100; step++) {
    const progress = opening ? step / 100 : 1 - step / 100;
    measured.left = full.left + 280 * progress; measured.width = full.width - 600 * progress;
    const home = layout.refresh();
    close(home.center.x, measured.width / 2, 'the chart still tracks the actual animated canvas');
    const areaLeft = measured.left - full.left, areaWidth = measured.width;
    close(parseFloat(rail.style.left) + parseFloat(rail.style.width) / 2, areaLeft + areaWidth / 2, 'the rail tracks the current animated center, not the final target');
    assert.ok(parseFloat(rail.style.left) >= areaLeft + 24 - 1e-8);
    assert.ok(parseFloat(rail.style.left) + parseFloat(rail.style.width) <= areaLeft + areaWidth - 24 + 1e-8);
    assert.equal(rail.style.top, initialTop, 'horizontal panel motion never lifts the rail');
    close(parseFloat(values.get('--timeline-area-left')), areaLeft);
    close(parseFloat(values.get('--timeline-area-width')), areaWidth);
    close(parseFloat(values.get('--timeline-content-left')), areaLeft + 24);
    close(parseFloat(values.get('--timeline-content-width')), areaWidth - 48);
    close(parseFloat(values.get('--timeline-dates-left')), measured.left - full.left + 24, 'dates follow each intermediate canvas position');
    close(parseFloat(values.get('--timeline-dates-width')), measured.width - 48, 'dates follow each intermediate canvas width');
  }
});

test('phone presentation publishes one mode and keeps the sheet above chronicle dates through keyboard changes', () => {
  const values = new Map(), shared = new Map(), modes: unknown[] = [];
  const full = { top: 0, bottom: 844, width: 390, height: 844 };
  const viewport = { height: 844, offsetTop: 0 }, media = { matches: true };
  const studio = { dataset: {} as DOMStringMap, parentElement: { style: { setProperty: (key, value) => shared.set(key, value) } },
    style: { setProperty: (key, value) => values.set(key, value) }, getBoundingClientRect: () => full };
  const canvas = { dataset: {} as DOMStringMap, parentElement: studio, getBoundingClientRect: () => full };
  const layout = createStudioLayout({ canvas, panels: [], viewport, media, timelineKind: 'chronicle',
    onPhoneLayout: phone => modes.push(phone),
    readStyle: () => ({ scrollPaddingTop: '112px', scrollPaddingLeft: '4px', getPropertyValue: () => '0px' }) });
  assert.deepEqual(modes, [true]);
  const sheetBottom = () => parseFloat(shared.get('--phone-sheet-bottom'));
  close(sheetBottom(), 80.6, 'phone sheet meets the edge of the full date row');
  viewport.height = 550;
  layout.refresh();
  close(parseFloat(shared.get('--phone-viewport-lift')), 294, 'a sheet without a timeline also clears the keyboard');
  close(sheetBottom(), 374.6, 'keyboard moves the entire sheet above the same visible controls');
  assert.deepEqual(modes, [true], 'layout measurements do not repeat mode changes');
  layout.setTimelineKind('day'); layout.refresh();
  close(sheetBottom(), 342, 'day sheet clears both the slider and its control container');
  media.matches = false; layout.refresh();
  assert.deepEqual(modes, [true, false], 'desktop independence is restored at the same device boundary');
  close(parseFloat(shared.get('--timeline-panels-bottom')), 324.6, 'desktop panel edge remains the original backing edge');
  layout.destroy();
});


test('a phone sheet never overlaps the full slider touch region, including above a compact day rail', () => {
  for (const safeBottom of [0, 6, 34]) for (const outset of [0, 6]) {
    const shared = new Map<string, string>();
    const full = { top: 0, bottom: 844, width: 390, height: 844 };
    const viewport = { height: 844, offsetTop: 0 };
    const studio = { dataset: {} as DOMStringMap,
      parentElement: { style: { setProperty: (key: string, value: string) => shared.set(key, value) } },
      style: { setProperty() {} }, getBoundingClientRect: () => full };
    const canvas = { dataset: {} as DOMStringMap, parentElement: studio, getBoundingClientRect: () => full };
    const rail = { style: { setProperty() {} } as unknown as CSSStyleDeclaration };
    const layout = createStudioLayout({ canvas, panels: [rail], viewport, media: { matches: true },
      readStyle: () => ({ scrollPaddingTop: '112px', scrollPaddingLeft: '4px', getPropertyValue: name =>
        name === '--timeline-safe-bottom' ? String(safeBottom) : name === '--timeline-hit-outset' ? String(outset) : '0' }) });
    const sliderTop = () => parseFloat(rail.style.top) + 4 - outset;
    for (const kind of ['day', 'chronicle', 'day'] as const) {
      layout.setTimelineKind(kind); layout.refresh();
      const sheetEdge = full.height - parseFloat(shared.get('--phone-sheet-bottom')!);
      assert.ok(sheetEdge <= Math.min(parseFloat(rail.style.top), sliderTop()) + 1e-8, `${kind}, inset ${safeBottom}, outset ${outset}: sheet must stop above slider`);
      if (kind === 'chronicle') assert.ok(sheetEdge <= full.height - 80.6 - safeBottom + 1e-8, 'dates also remain accessible');
    }
    viewport.height = 550; layout.refresh();
    assert.ok(full.height - parseFloat(shared.get('--phone-sheet-bottom')!) <= Math.min(parseFloat(rail.style.top), sliderTop()) - 294 + 1e-8, 'keyboard lifts both touch surfaces together');
    layout.destroy();
  }
});
