import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const page = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const styles = readFileSync(new URL('../public/styles.css', import.meta.url), 'utf8');

// Inspect actual ancestry, including the nested heading inside the controls.
const nodes = [], stack = [];
const voidElements = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
for (const match of page.matchAll(/<(\/?)([a-z][\w-]*)\b([^>]*)>/gi)) {
  const [, closing, tag, attributes] = match;
  if (closing) {
    assert.equal(stack.pop()?.tag, tag, `balanced markup at ${match[0]}`);
    continue;
  }
  const node = { tag, attributes, parent: stack.at(-1), index: match.index };
  nodes.push(node);
  if (!voidElements.has(tag) && !/\/\s*$/.test(attributes)) stack.push(node);
}
const byId = id => {
  const found = nodes.filter(node => new RegExp(`\\bid="${id}"`).test(node.attributes));
  assert.equal(found.length, 1, `${id} exists exactly once`);
  return found[0];
};

// These assertions cover screen layout, not the separate print-only fallback.
// Print blocks here contain declaration rules, without nested media queries.
const screenStyles = styles.replace(/\/\*[\s\S]*?\*\//g, '').replace(/@media print\s*\{(?:[^{}]|\{[^{}]*\})*\}/g, '');
function parseRules(source, media = []) {
  const parsed = [];
  let start = 0;
  while (start < source.length) {
    const open = source.indexOf('{', start);
    if (open === -1) break;
    let end = open + 1, depth = 1;
    for (; end < source.length && depth; end++) {
      if (source[end] === '{') depth++;
      else if (source[end] === '}') depth--;
    }
    assert.equal(depth, 0, 'stylesheet blocks are balanced');
    const selector = source.slice(start, open).trim(), body = source.slice(open + 1, end - 1);
    if (selector.startsWith('@media ')) parsed.push(...parseRules(body, [...media, selector.slice(7).trim()]));
    else parsed.push({ selector, media,
      declarations: Object.fromEntries([...body.matchAll(/([\w-]+)\s*:\s*([^;]+)\s*(?:;|$)/g)].map(([, name, value]) => [name, value.trim()])),
    });
    start = end;
  }
  return parsed;
}
const rules = parseRules(screenStyles);
function declarationsAt(selector, width, height) {
  const matches = query => query.split(/\s+and\s+/).every(condition => {
    const parts = /^\((min|max)-(width|height):\s*(\d+)px\)$/.exec(condition);
    if (!parts) return false;
    const value = parts[2] === 'width' ? width : height, limit = Number(parts[3]);
    return parts[1] === 'min' ? value >= limit : value <= limit;
  });
  return Object.assign({}, ...rules.filter(rule => rule.selector.split(',').some(value => value.trim() === selector)
    && rule.media.every(matches)).map(rule => rule.declarations));
}

test('component defaults have one home and no removed zoom-toolbar styles remain', () => {
  const defaults = rules.filter(rule => rule.media.length === 0).map(rule => rule.selector);
  assert.equal(new Set(defaults).size, defaults.length, 'component defaults are consolidated instead of accumulating overrides');
  assert.doesNotMatch(styles, /\.canvas-controls\b|\.zoom-value\b|\.control-divider\b/);
  assert.doesNotMatch(page, /class="[^"]*\b(?:canvas-controls|zoom-value|control-divider)\b/);
});

test('consolidated form styles retain their small-screen overrides', () => {
  assert.equal(declarationsAt('.city-results', 1440, 900)['max-height'], '208px');
  for (const [width, height] of [[568, 320], [390, 844], [320, 568]]) {
    assert.equal(declarationsAt('.city-results', width, height)['max-height'], '190px');
    const modes = declarationsAt('.calculation-mode button', width, height);
    assert.equal(modes['padding-left'], '7px');
    assert.equal(modes['padding-right'], '7px');
  }
  assert.equal(declarationsAt('.dialog-content', 390, 844).padding, '22px');
  assert.equal(declarationsAt('.dialog-content', 320, 568).padding, '18px');
});

test('both day sliders are separate studio children after the full drawing viewport', () => {
  const canvas = byId('canvasWrap'), controls = byId('transitControls'), graph = byId('bodygraph');
  assert.match(canvas.parent.attributes, /\bclass="[^"]*\bstudio\b/);
  assert.equal(controls.parent, canvas.parent, 'the footer and canvas share the studio parent');
  assert.ok(controls.index > canvas.index, 'the footer follows the chart in document order');
  assert.equal(graph.parent, canvas, 'the SVG stays inside the full drawing viewport');
  assert.doesNotMatch(page, /mandalaCrossReadout/, 'the chart has no textual cross caption');
  assert.equal(byId('transitTime').parent, controls, 'the existing range remains in its own control panel');
  assert.match(controls.attributes, /\bhidden(?:\s|$)/, 'the transit controller owns visibility after bootstrap');
  const natal = byId('chartDayControls'), toggle = byId('chartDayToggle');
  assert.equal(natal.parent, canvas.parent, 'the optional birth-day slider uses the same separate interface area');
  assert.ok(natal.index > canvas.index);
  assert.equal(byId('chartDayTime').parent, natal);
  assert.match(natal.attributes, /\bhidden(?:\s|$)/, 'birth-day exploration starts closed');
  assert.match(toggle.attributes, /aria-controls="chartDayControls"/);
  assert.match(toggle.attributes, /aria-expanded="false"/);
  for (const node of [controls, natal]) assert.match(node.attributes, /\bclass="[^"]*\bday-controls\b/);
});

test('permanent equal chrome bands leave the full drawing viewport unchanged when sliders open or close', () => {
  const studio = Object.assign({}, ...rules.filter(({ selector }) => selector === '.studio').map(rule => rule.declarations));
  assert.equal(studio.display, 'grid');
  assert.match(studio['grid-template-rows'], /^var\(--studio-edge-space\)\s+minmax\(0,\s*1fr\)\s+var\(--studio-edge-space\)$/, 'equal permanent bands position the interface without moving the drawing center');
  assert.ok(rules.some(rule => rule.declarations['--studio-edge-space']), 'the interface bands have a defined size');
  for (const { selector, declarations } of rules.filter(({ selector }) => selector.includes('.studio') && selector.includes(':has('))) {
    assert.ok(!declarations['grid-template-rows'], `${selector} cannot move the canvas when auxiliary controls change visibility`);
  }

  const canvasRules = rules.filter(({ selector }) => selector === '.canvas-wrap' || selector === '.studio > .canvas-wrap');
  const canvas = Object.assign({}, ...canvasRules.map(rule => rule.declarations));
  assert.equal(canvas.position, 'absolute', 'the drawing is independent of the footer grid row');
  assert.equal(canvas.inset, '0', 'the drawing reaches all viewport edges');
  assert.equal(canvas.height, '100%', 'the SVG is never cropped to the middle chrome band');
  assert.ok(!canvas['grid-row'], 'the drawing is not confined to a smaller grid cell');
  assert.equal(canvas['min-height'], '0');
  assert.match(canvas['scroll-padding'], /^calc\(var\(--studio-edge-space\)\s*\+\s*12px\)\s+20px$/, 'Home can measure equal safe areas while the canvas remains full size');
});

test('the fullscreen drawing has no CSS fade, blur or compositing mask at any breakpoint', () => {
  assert.doesNotMatch(styles, /(?:mask-image|mask-composite|backdrop-filter)\s*:|blur\(/);
  for (const [width, height] of [[1440, 900], [844, 390], [568, 320], [390, 844]]) {
    const header = declarationsAt('.studio-header .chart-heading', width, height);
    assert.equal(header.width, 'fit-content', 'the backing follows only the caption, not a whole canvas strip');
    assert.equal(header['max-width'], '100%');
    assert.equal(header.background, 'var(--canvas-background)', 'an opaque flat backing keeps the caption legible');
    assert.equal(header.padding, '5px 10px');
  }
});

test('the thin day sliders use a compact flat backing in the bottom row', () => {
  const controlsRules = rules.filter(({ selector }) => selector.split(',').some(part => part.trim() === '.day-controls'));
  assert.ok(controlsRules.length);
  for (const { selector, declarations } of controlsRules) {
    assert.ok(!['absolute', 'fixed'].includes(declarations.position), `${selector} keeps the slider in normal flow`);
    assert.ok(!declarations.transform || declarations.transform === 'none', 'no responsive translation can move the footer over the chart');
    for (const property of ['top', 'right', 'bottom', 'left', 'inset']) {
      assert.ok(!declarations[property] || declarations[property] === 'auto', `${property} does not offset the footer into the chart`);
    }
  }
  const controls = Object.assign({}, ...controlsRules.map(rule => rule.declarations));
  assert.equal(controls['grid-row'], '3', 'both mutually exclusive sliders share the separate bottom row');
  assert.equal(controls.background, 'var(--canvas-background)', 'the timeline stays readable without filtering the drawing');
  assert.equal(controls.padding, '0 12px', 'the backing adds no height or reserved band');
  assert.equal(controls.width, 'min(440px, calc(100% - 36px))', 'the backing stays local to the slider');
  assert.equal(controls.border, '0', 'the timeline has no card outline');
  assert.equal(controls['box-shadow'], 'none', 'the timeline has no card shadow');
  for (const selector of [".day-controls input[type='range']::-webkit-slider-runnable-track", ".day-controls input[type='range']::-moz-range-track"]) {
    const track = Object.assign({}, ...rules.filter(rule => rule.selector === selector).map(rule => rule.declarations));
    assert.equal(track.height, '2px', 'the visible range track stays thin across browser engines');
  }
  assert.doesNotMatch(styles, /\.canvas-wrap:has\(\.transit-controls/, 'no obsolete descendant selector assumes the slider is inside the chart');
});

test('the title stays centered outside the short-landscape toolbar layout', () => {
  for (const [width, height] of [[1440, 900], [900, 800], [390, 844], [1200, 400]]) {
    const heading = declarationsAt('.studio-header', width, height);
    assert.equal(heading.left, '50%', `${width}×${height} centers its title`);
    assert.equal(heading.right, 'auto');
    assert.equal(heading.transform, 'translateX(-50%)');
    assert.equal(heading['text-align'], 'center');
  }
  assert.equal(byId('chartTitle').parent.parent.parent.parent, byId('canvasWrap').parent, 'the title and drawing use the same studio coordinate space');
});

test('Home sits left of the adjacent clock and Mandala controls without changing their order', () => {
  const tools = byId('fitButton').parent;
  assert.deepEqual(nodes.filter(node => node.parent === tools && node.tag === 'button')
    .map(node => /\bid="([^"]+)"/.exec(node.attributes)?.[1]), ['fitButton', 'chartDayToggle', 'mandalaSwitch', 'summarySwitch']);
  assert.match(byId('fitButton').attributes, /\bhidden(?:\s|$)/, 'the fitted initial chart starts without Home');
  assert.equal(byId('chartDayToggle').parent, byId('mandalaSwitch').parent);
});

test('short-landscape titles leave room for Menu and all four chart tools', () => {
  for (const [width, height] of [[568, 320], [844, 390], [1000, 500]]) {
    const heading = declarationsAt('.studio-header', width, height);
    assert.equal(heading.left, '76px', `${width}×${height} leaves space for Menu`);
    assert.equal(heading.transform, 'none');
    assert.equal(heading['text-align'], 'left');
    assert.equal(heading.width, 'calc(100% - 380px)');
    assert.equal(declarationsAt('.studio-header .chart-heading', width, height)['align-items'], 'flex-start');
    assert.equal(declarationsAt('.studio-header .chart-title-row', width, height)['justify-content'], 'flex-start');
    const titleRight = Number.parseFloat(heading.left) + width - 380;
    const toolbar = declarationsAt('.chart-tools', width, height);
    const iconWidth = Number.parseFloat(declarationsAt('.chart-tools .icon-button', width, height).width);
    const fixedTools = 3 * iconWidth + 3 * Number.parseFloat(toolbar.gap) + Number.parseFloat(toolbar.right);
    assert.ok(width - titleRight - fixedTools >= 128, 'after three icons and gaps, the toolbar retains space for the wider Mandala switch');
    assert.ok(width - 380 > 0, 'the title retains positive readable width');
  }
});

test('printing hides both day sliders and restores the full print drawing height', () => {
  const printBlocks = [...styles.matchAll(/@media print\s*\{(?:[^{}]|\{[^{}]*\})*\}/g)].map(match => match[0]).join('\n');
  assert.match(printBlocks, /\.day-controls\s*\{[^}]*display:\s*none\s*!important/);
  assert.match(printBlocks, /\.studio\s*>\s*\.canvas-wrap\s*\{[^}]*height:\s*260mm/);
  assert.doesNotMatch(printBlocks, /mask-image|mask-composite|backdrop-filter|blur\(/);
});
