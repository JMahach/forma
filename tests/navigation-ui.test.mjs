import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chartTitle } from '../src/views/chart-display.js';
import { attachChartLibrary, createChartLibraryView } from '../src/views/library.js';
import { libraryDom } from './helpers/library-dom.mjs';
import { attachTransitNavigation } from '../src/views/live-transit.js';
import { attachCameraControls } from '../src/views/camera-controls.js';
import { prepareLoadingPage } from '../src/scene/loading-placeholder.js';

const bootstrapSource = readFileSync(new URL('../src/app.js', import.meta.url), 'utf8');
const appSource = [bootstrapSource, ...[
  'views/chart-display.js', 'views/library.js', 'views/birth-form.js',
  'views/live-transit.js', 'scene/updates.js', 'views/camera-controls.js',
].map(path => readFileSync(new URL(`../src/${path}`, import.meta.url), 'utf8'))].join('\n');
const pageSource = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');

test('transit is consistently named without renaming saved personal charts', () => {
  const button = pageSource.match(/<button\b[^>]*id="nowButton"[^>]*>[\s\S]*?<\/button>/)?.[0];
  assert.match(button, /<span>Транзит<\/span>/);
  assert.match(button, /title="Транзит"/);
  assert.doesNotMatch(pageSource + appSource, /Текущий момент/);
  assert.match(bootstrapSource, /\$\('chartTitle'\)\.textContent\s*=\s*chartTitle\(/, 'the application uses the public title policy');
  for (const [c, expected] of [
    [{ id: 'current-transit', name: 'Текущий момент', source: 'transit' }, 'Транзит'],
    [{ id: 'current-transit', name: 'Legacy moment' }, 'Транзит'],
    [{ id: 'legacy-transit', name: 'Old transit', source: 'transit' }, 'Транзит'],
    [{ id: 'personal', name: 'Марат', source: 'calculated' }, 'Марат'],
    [{ id: 'manual', name: 'Текущий момент', source: 'manual' }, 'Текущий момент'],
  ]) {
    Object.freeze(c);
    assert.equal(chartTitle(c), expected);
  }
});

test('removed legacy panels leave no DOM nodes, event bindings, or renderer calls', () => {
  for (const id of ['details', 'detailContent', 'closeDetails', 'modeLabel', 'activeCount', 'channelCount', 'exampleButton', 'currentChartActions']) {
    assert.ok(!pageSource.includes(`id="${id}"`), `${id} is removed, not merely hidden`);
    assert.ok(!appSource.includes(`$('${id}')`), `${id} has no dangling binding`);
  }
  assert.doesNotMatch(appSource, /renderDetails|data-view|liniya\.last/);
  assert.doesNotMatch(pageSource, /class="(?:view-switch|canvas-bottomline|chart-footer)"/);
});

test('every statically referenced app element exists in the prepared page after cleanup', () => {
  const preparedPage = prepareLoadingPage(pageSource);
  const allIds = [...preparedPage.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
  const ids = new Set(allIds);
  assert.equal(ids.size, allIds.length, 'server-prepared illustration adds no duplicate element IDs');
  assert.doesNotMatch(preparedPage, /<!-- chart-loading-placeholder -->/);
  for (const [, id] of appSource.matchAll(/\$\('([^']+)'\)/g)) {
    assert.ok(ids.has(id), `${id} is available to app bootstrap and event handlers`);
  }
});

test('the top bar contains only the menu; navigation actions have one sidebar entry each', () => {
  const topbar = pageSource.match(/<header\b[^>]*class="topbar"[^>]*>([\s\S]*?)<\/header>/)?.[1];
  const sidebar = pageSource.match(/<aside\b[^>]*id="library"[^>]*>([\s\S]*?)<\/aside>/)?.[1];
  assert.ok(topbar, 'top bar exists');
  assert.ok(sidebar, 'left sidebar exists');
  assert.deepEqual([...topbar.matchAll(/<button\b[^>]*\bid="([^"]+)"/g)].map(match => match[1]), ['openLibrary']);
  assert.equal([...topbar.matchAll(/<button\b/g)].length, 1, 'no unlabelled duplicate actions in the top bar');
  for (const id of ['nowButton', 'openKnowledge', 'newChartButton']) {
    assert.equal([...pageSource.matchAll(new RegExp(`\\bid="${id}"`, 'g'))].length, 1, `${id} exists exactly once`);
    assert.match(sidebar, new RegExp(`\\bid="${id}"`), `${id} is inside the left menu`);
  }
  assert.doesNotMatch(pageSource, /\bid="quickNewChart"/, 'the redundant quick-new button is removed');
  assert.doesNotMatch(appSource, /\$\('quickNewChart'\)/, 'no listener accesses the removed button');
});

test('current moment and library precede the separate saved-chart section', () => {
  const navigation = pageSource.match(/<(nav|section|div)\b[^>]*id="mainNavigation"[^>]*>([\s\S]*?)<\/\1>/)?.[2];
  const charts = pageSource.match(/<section\b[^>]*id="savedChartsSection"[^>]*>([\s\S]*?)<\/section>/)?.[1];
  assert.ok(navigation, 'primary navigation is a separate block');
  assert.ok(charts, 'saved charts have a separate section');
  assert.ok(navigation.indexOf('id="nowButton"') >= 0);
  assert.ok(navigation.indexOf('id="nowButton"') < navigation.indexOf('id="openKnowledge"'), 'current moment is first, then library');
  assert.ok(pageSource.indexOf('id="mainNavigation"') < pageSource.indexOf('id="savedChartsSection"'), 'navigation is above saved charts');
  assert.ok(charts.indexOf('id="newChartButton"') >= 0);
  assert.ok(charts.indexOf('id="newChartButton"') < charts.indexOf('id="chartList"'), 'new chart precedes the personal chart list');
  assert.match(charts, /id="libraryCount"/, 'the personal-chart count belongs to the personal section');
  assert.doesNotMatch(charts, /id="(?:nowButton|openKnowledge)"/);
});

test('the sidebar has no close cross and is inaccessible until the menu is opened', () => {
  const sidebar = pageSource.match(/<aside\b[^>]*id="library"[^>]*>([\s\S]*?)<\/aside>/)?.[0];
  assert.ok(sidebar);
  assert.match(sidebar, /^<aside\b[^>]*\binert(?:\s|>)/);
  assert.doesNotMatch(sidebar, /id="closeLibrary"|Закрыть меню|[×✕]/);
  assert.doesNotMatch(appSource, /\$\('closeLibrary'\)/, 'no listener references the removed cross');
  assert.match(pageSource, /<button\b[^>]*id="openLibrary"[^>]*aria-controls="library"[^>]*aria-expanded="false"/);
});

test('the menu is reachable above the open right drawer backdrop but remains below its own left drawer', () => {
  const styles = readFileSync(new URL('../public/styles.css', import.meta.url), 'utf8');
  const zIndex = pattern => Number(styles.match(pattern)?.[1]);
  const normalMenu = zIndex(/^\.topbar \{[^}]*z-index:\s*(\d+)/m);
  const rightBackdrop = zIndex(/^\.summary-backdrop \{[^}]*z-index:\s*(\d+)/m);
  const raisedMenu = zIndex(/^\.app-shell:has\(\.chart-summary\.open\) \.topbar \{[^}]*z-index:\s*(\d+)/m);
  const leftDrawer = zIndex(/^\.library \{[^}]*z-index:\s*(\d+)/m);
  assert.ok(normalMenu < rightBackdrop, 'normal menu keeps its original stacking level');
  assert.ok(raisedMenu > rightBackdrop, 'the actual Menu click reaches its handler while About is open');
  assert.ok(raisedMenu < leftDrawer, 'opening the left library covers its own Menu button as before');
});

function menuHarness() {
  const elements = new Map(), handlers = new Map();
  let renders = 0, popupCloses = 0;
  const document = {
    activeElement: null,
    getElementById(id) { return element(id); },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    addEventListener(type, handler) { handlers.set(type, handler); },
  };
  const sidebarChildren = new Set(['nowButton', 'openKnowledge', 'newChartButton', 'chartList']);
  const element = id => {
    if (!elements.has(id)) {
      const classes = new Set(), attributes = new Map();
      let markup = '';
      elements.set(id, {
        id, inert: id === 'library', hidden: id === 'libraryBackdrop',
        get innerHTML() { return markup; },
        set innerHTML(value) { markup = String(value); if (id === 'chartList') renders++; },
        getBoundingClientRect() { return { top: 0, bottom: 200 }; },
        contains(node) { return node === this || id === 'library' && sidebarChildren.has(node?.id); },
        focus() { document.activeElement = this; },
        setAttribute(name, value) { attributes.set(name, String(value)); },
        getAttribute(name) { return attributes.get(name) ?? null; },
        classList: {
          add(name) { classes.add(name); },
          remove(name) { classes.delete(name); },
          contains(name) { return classes.has(name); },
        },
        addEventListener(type, handler) { handlers.set(`${id}:${type}`, handler); },
      });
    }
    return elements.get(id);
  };
  const library = attachChartLibrary({
    document,
    session: { selectedId: 'current-transit' },
    store: { charts: [], remove() { assert.fail('opening a menu must not delete a chart'); } },
    onSelect() { assert.fail('opening a menu does not select a chart'); },
    onEdit() { assert.fail('opening a menu does not edit a chart'); },
    onNew() { assert.fail('opening a menu does not create a chart'); },
    beforeOpen() { popupCloses++; },
    toast() {},
  });
  const context = { closeMenu: library.close };
  const click = id => handlers.get(`${id}:click`)();
  const key = value => handlers.get('keydown')({ key: value, preventDefault() {} });
  return { element, document, context, click, key, get renders() { return renders; }, get popupCloses() { return popupCloses; } };
}

test('the menu button opens the drawer, enables it, and moves focus to current moment', () => {
  const harness = menuHarness();
  harness.element('openLibrary').focus();
  harness.click('openLibrary');
  assert.equal(harness.renders, 0, 'an empty listing needs no DOM replacement');
  assert.equal(harness.popupCloses, 1, 'opening the drawer dismisses any activation popup');
  assert.equal(harness.element('library').classList.contains('open'), true);
  assert.equal(harness.element('library').inert, false);
  assert.equal(harness.element('libraryBackdrop').hidden, false);
  assert.equal(harness.element('openLibrary').getAttribute('aria-expanded'), 'true');
  assert.equal(harness.document.activeElement, harness.element('nowButton'));
});

test('backdrop and Escape dismiss the cross-free menu and return focus to the menu button', () => {
  for (const method of ['backdrop', 'escape']) {
    const harness = menuHarness();
    harness.click('openLibrary');
    harness.key('Enter');
    assert.equal(harness.element('library').classList.contains('open'), true, 'other keys do not dismiss the menu');
    if (method === 'backdrop') harness.click('libraryBackdrop'); else harness.key('Escape');
    assert.equal(harness.element('library').classList.contains('open'), false, method);
    assert.equal(harness.element('library').inert, true, `${method} disables hidden controls`);
    assert.equal(harness.element('libraryBackdrop').hidden, true, method);
    assert.equal(harness.element('openLibrary').getAttribute('aria-expanded'), 'false', method);
    assert.equal(harness.document.activeElement, harness.element('openLibrary'), `${method} restores focus`);
  }
});

test('closing the menu does not steal focus already moved outside the drawer', () => {
  const harness = menuHarness();
  harness.click('openLibrary');
  harness.element('bodygraph').focus();
  harness.context.closeMenu();
  assert.equal(harness.document.activeElement, harness.element('bodygraph'));
  assert.equal(harness.element('library').inert, true);
});

// Run the real renderer with synthetic fixtures only. No application bootstrap,
// storage, network calls, timers, or real browser charts are involved.
function libraryHarness(savedCharts, selectedChartId = 'current-transit') {
  const dom = libraryDom();
  const view = createChartLibraryView({ ...dom, createObserver: () => ({ observe() {}, disconnect() {} }), schedule() {} });
  const context = { savedCharts, selectedChartId, render() { view.update(context.savedCharts, context.selectedChartId); } };
  context.render(); view.show();
  return { context, element: id => dom[id] };
}

test('the personal-chart count and list exclude current and legacy transits without changing stored records', () => {
  const fixtures = [
    { id: 'current-transit', name: 'Текущий момент', source: 'transit' },
    { id: 'marat', name: 'Марат', source: 'calculated', birthDate: '2000-01-02', birthTime: '03:04' },
    { id: 'legacy-transit', name: 'Older live chart', source: 'transit' },
    { id: 'manual-card', name: 'Ручная карта', source: 'manual' },
  ];
  fixtures.forEach(Object.freeze);
  Object.freeze(fixtures);
  const before = JSON.stringify(fixtures);
  const { element, context } = libraryHarness(fixtures, 'marat');
  assert.equal(element('libraryCount').textContent, '2');
  const list = element('chartList').innerHTML;
  assert.deepEqual([...list.matchAll(/\bdata-chart-id="([^"]+)"/g)].map(match => match[1]), ['marat', 'manual-card']);
  assert.doesNotMatch(list, /current-transit|legacy-transit|Текущий момент|Older live chart/);
  assert.match(list, /data-chart-id="marat"[^>]*aria-pressed="true"/);
  assert.match(list, /data-chart-id="manual-card"[^>]*aria-pressed="false"/);
  for (const id of ['marat', 'manual-card']) {
    for (const action of ['edit', 'delete']) {
      assert.match(list, new RegExp(`data-chart-action="${action}"[^>]*data-action-chart-id="${id}"`), `personal ${id} retains ${action}`);
    }
  }
  assert.equal(element('nowButton').getAttribute('aria-pressed'), 'false');
  assert.equal(JSON.stringify(fixtures), before, 'rendering does not mutate records');
  assert.equal(context.savedCharts, fixtures, 'rendering does not replace the saved collection');
});

test('current moment is active independently of the saved list, including before the first live calculation', () => {
  const cases = [
    [],
    [{ id: 'marat', name: 'Марат', source: 'manual' }],
    [{ id: 'current-transit', name: 'Текущий момент', source: 'transit' }],
    [{ id: 'current-transit', name: 'Legacy current moment', source: 'manual' }],
  ];
  for (const fixture of cases) {
    const { element, context } = libraryHarness(fixture);
    assert.equal(element('libraryCount').textContent, String(fixture.filter(chart => chart.id !== 'current-transit' && chart.source !== 'transit').length));
    assert.equal(element('nowButton').getAttribute('aria-pressed'), 'true', 'default navigation is active even without a cached live chart');
    assert.doesNotMatch(element('chartList').innerHTML, /data-chart-id="current-transit"/);
    assert.doesNotMatch(element('chartList').innerHTML, /aria-pressed="true"/, 'no personal chart is active while current moment is selected');
    context.selectedChartId = 'marat';
    context.render();
    assert.equal(element('nowButton').getAttribute('aria-pressed'), 'false', 'navigation state updates when a personal chart is selected');
  }
});

test('current-moment navigation selects the transit view immediately even before its first day packet arrives', () => {
  assert.match(bootstrapSource, /attachTransitNavigation\(\$\('nowButton'\)/, 'the application connects the public transit navigation adapter');
  for (const cached of [false, true]) {
    const calls = [];
    let handler;
    const button = { addEventListener(type, callback) { assert.equal(type, 'click'); handler = callback; } };
    attachTransitNavigation(button, {
      closeLibrary() { calls.push('close'); },
      onSelect(id) { calls.push(`select:${id}`); },
      refresh(open) { calls.push(`refresh:${open}`); },
    });
    assert.equal(typeof handler, 'function');
    handler();
    assert.deepEqual(calls, ['close', 'select:current-transit', 'refresh:true']);
  }
});

test('the fit control uses a decorative home icon and retains its accessible label and camera-reset action', () => {
  const fitButton = pageSource.match(/<button\b[^>]*id="fitButton"[^>]*>[\s\S]*?<\/button>/)?.[0];
  assert.ok(fitButton, 'fit control exists');
  assert.match(fitButton, /aria-label="Показать всю схему"/);
  assert.match(fitButton, /title="Вся схема"/);
  assert.match(fitButton, /<svg\b[^>]*viewBox="0 0 20 20"[^>]*aria-hidden="true"/);
  assert.match(fitButton, /<path\b[^>]*stroke="currentColor"/);
  assert.doesNotMatch(fitButton, /⤢/, 'the previous expand-arrows glyph is removed');
  assert.match(bootstrapSource, /attachCameraControls\(/, 'the application connects the public camera control adapter');
  const handlers = new Map();
  let resets = 0;
  const element = id => ({ addEventListener(type, handler) { assert.equal(type, 'click'); handlers.set(id, handler); } });
  attachCameraControls({ fitButton: element('fitButton') }, {
    reset() { resets++; }, zoom() { assert.fail('the home button must reset, not increment the zoom'); },
  });
  handlers.get('fitButton')();
  assert.equal(resets, 1, 'home icon still restores the fitted camera view');
});
