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
function declarationsAt(selector, width, height, { coarse = false } = {}) {
  const matches = query => query.split(',').some(branch => branch.trim().split(/\s+and\s+/).every(condition => {
    const pointer = /^\(pointer:\s*(coarse|fine)\)$/.exec(condition);
    if (pointer) return (pointer[1] === 'coarse') === coarse;
    const orientation = /^\(orientation:\s*(portrait|landscape)\)$/.exec(condition);
    if (orientation) return (orientation[1] === 'portrait') === (height >= width);
    const parts = /^\((min|max)-(width|height):\s*(\d+)px\)$/.exec(condition);
    if (!parts) return false;
    const value = parts[2] === 'width' ? width : height, limit = Number(parts[3]);
    return parts[1] === 'min' ? value >= limit : value <= limit;
  }));
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

test('normal activation spacing moves each complete source block symmetrically on the main chart only', () => {
  const shifts = rules.filter(rule => rule.declarations.translate?.includes('--activation-rest-gap'));
  assert.equal(shifts.length, 2, 'one source-level translation per side, not another shift on each child');
  const seen = [];
  for (const rule of shifts) {
    const match = /^#bodygraph :is\(([^)]+)\)\[data-source=['"](design|personality)['"]\]$/.exec(rule.selector);
    assert.ok(match, 'the extra spacing is restricted to the main bodygraph, never library thumbnails');
    assert.deepEqual(match[1].split(',').map(selector => selector.trim()).sort(),
      ['.activation-column', '.variable-block'],
      'planetary values, Color/Tone labels and arrows move together, but neither channels nor centers move');
    const source = match[2];
    seen.push(source);
    assert.deepEqual(rule.media, [], 'both sources use the same spacing across responsive sizes');
    assert.deepEqual(Object.keys(rule.declarations), ['translate'], 'independent translation preserves existing SVG and mandala transforms');
    assert.equal(rule.declarations.translate, source === 'design' ? 'calc(-1 * var(--activation-rest-gap)) 0' : 'var(--activation-rest-gap) 0');
  }
  assert.deepEqual(seen.sort(), ['design', 'personality']);
  assert.equal(declarationsAt(".activation-column[data-source='design']", 1440, 900).transform, 'translateX(calc(-1 * var(--activation-column-offset, 0px)))');
  assert.equal(declarationsAt(".activation-column[data-source='personality']", 1440, 900).transform, 'translateX(var(--activation-column-offset, 0px))');
  for (const rule of rules.filter(rule => /\.bodygraph-variable(?:\[|\s|,|\))/.test(rule.selector))) {
    assert.equal(rule.declarations.transform, undefined, 'arrow placement attributes must not be overwritten by a CSS transform');
  }
});

test('the fourteen-unit resting gap disappears continuously at the inherited mandala endpoint', () => {
  const definitions = rules.filter(rule => '--activation-rest-gap' in rule.declarations);
  assert.equal(definitions.length, 2);
  const readGap = (selector, reveal) => {
    const rule = definitions.find(candidate => candidate.selector === selector);
    assert.ok(rule, `${selector} owns its explicit reveal fallback`);
    assert.deepEqual(rule.media, []);
    const formula = /^calc\((\d+)px \* \(1 - var\(--mandala-reveal, ([01])\)\)\)$/.exec(rule.declarations['--activation-rest-gap']);
    assert.ok(formula, 'spacing follows the shared reveal instead of a separate animation');
    assert.equal(Number(formula[1]), 14);
    return Number(formula[1]) * (1 - (reveal ?? Number(formula[2])));
  };
  assert.equal(readGap('#bodygraph .bodygraph-drawing'), 14, 'normal standalone rendering expands each side by fourteen SVG units');
  assert.equal(readGap('#bodygraph .mandala-drawing'), 0, 'standalone mandala fallback retains its original columns');
  for (const selector of ['#bodygraph .bodygraph-drawing', '#bodygraph .mandala-drawing']) {
    assert.equal(readGap(selector, 0), 14);
    assert.equal(readGap(selector, .5), 7);
    assert.equal(readGap(selector, 1), 0, 'expanded inherited reveal cannot add space beyond the existing mandala offset');
  }
});

test('both day sliders are separate studio children after the full drawing viewport', () => {
  const canvas = byId('canvasWrap'), controls = byId('transitControls'), graph = byId('bodygraph');
  assert.match(canvas.parent.attributes, /\bclass="[^"]*\bstudio\b/);
  assert.equal(controls.parent, canvas.parent, 'the footer and canvas share the studio parent');
  assert.ok(controls.index > canvas.index, 'the footer follows the chart in document order');
  assert.equal(graph.parent, canvas, 'the SVG stays inside its drawing viewport');
  assert.doesNotMatch(page, /mandalaCrossReadout/, 'the chart has no textual cross caption');
  assert.equal(byId('transitTime').parent.parent, controls, 'the native range wrapper remains in its own control panel');
  assert.match(controls.attributes, /\bhidden(?:\s|$)/, 'the transit controller owns visibility after bootstrap');
  const natal = byId('chartDayControls'), toggle = byId('chartDayToggle');
  assert.equal(natal.parent, canvas.parent, 'the optional birth-day slider uses the same separate interface area');
  assert.ok(natal.index > canvas.index);
  assert.equal(byId('chartDayTime').parent.parent, natal);
  assert.match(natal.attributes, /\bhidden(?:\s|$)/, 'birth-day exploration starts closed');
  assert.match(toggle.attributes, /aria-controls="chartDayControls"/);
  assert.match(toggle.attributes, /aria-expanded="false"/);
  for (const node of [controls, natal]) assert.match(node.attributes, /\bclass="[^"]*\bday-controls\b/);
  for (const [id, context] of [['transitTime', 'транзита'], ['chartDayTime', 'рождения']]) {
    assert.match(byId(id).attributes, /type="range"/);
    assert.match(byId(id).attributes, /step="1"/);
    assert.match(byId(id).parent.attributes, /\bclass="day-range"/);
    assert.match(page, new RegExp(`<label[^>]*for="${id}"[^>]*>Шкала дня: время ${context}</label>`));
  }
  assert.match(page, /id="chartDayReset" title="Вернуться к сохранённому времени рождения">К рождению<\/button>/);
});

test('permanent studio insets retain the full drawing viewport independently of slider visibility', () => {
  assert.equal(declarationsAt('.studio', 390, 844).display, 'block');
  assert.ok(rules.some(rule => rule.declarations['--studio-top-space']));
  assert.ok(rules.some(rule => rule.declarations['--studio-bottom-space']));
  for (const rule of rules.filter(rule => /hidden|day-controls|transitControls|chartDayControls/.test(rule.selector))) {
    assert.equal(rule.declarations['--studio-top-space'], undefined);
    assert.equal(rule.declarations['--studio-bottom-space'], undefined);
    assert.equal(rule.declarations['scroll-padding'], undefined);
  }
  for (const [width, height] of [[320, 568], [393, 747], [699, 390], [700, 844], [844, 390], [997, 747], [1009, 747], [1440, 900]]) {
    const canvas = { ...declarationsAt('.canvas-wrap', width, height), ...declarationsAt('.studio > .canvas-wrap', width, height) };
    assert.equal(canvas.position, 'absolute');
    assert.equal(canvas.inset, '0');
    assert.equal(canvas.height, '100%');
    assert.equal(canvas['min-height'], '0');
    assert.ok(canvas['scroll-padding'].includes('var(--studio-top-space)'));
    assert.ok(canvas['scroll-padding'].includes('var(--studio-bottom-space)'));
  }
});


test('the drawing has no CSS fade, blur or compositing mask at any breakpoint', () => {
  assert.doesNotMatch(styles, /(?:mask-image|mask-composite|backdrop-filter)\s*:|blur\(/);
  for (const [width, height] of [[1440, 900], [844, 390], [568, 320], [390, 844]]) {
    const header = declarationsAt('.studio-header .chart-heading', width, height);
    assert.equal(header.width, 'fit-content', 'the backing follows only the caption, not a whole canvas strip');
    assert.equal(header['max-width'], '100%');
    assert.equal(header.background, 'var(--canvas-background)', 'an opaque flat backing keeps the caption legible');
    assert.equal(header.padding, '5px 10px');
  }
});

test('the day slider keeps its 48px hit area but paints only a slim rounded local backing', () => {
  for (const [width, height] of [[320, 568], [393, 747], [844, 390], [1440, 900]]) {
    const controls = declarationsAt('.day-controls', width, height);
    assert.equal(controls.position, 'absolute', 'measured layout owns placement, independent of panel contents');
    assert.equal(controls.height, '48px');
    assert.equal(controls.padding, '0');
    assert.equal(controls.border, '0');
    assert.equal(controls['box-shadow'], 'none');
    assert.equal(controls.background, 'transparent', 'the hit area cannot hide a full-height strip of the chart');
    const backing = declarationsAt('.day-controls::before', width, height);
    assert.equal(backing.position, 'absolute');
    assert.equal(backing.inset, '13px -8px 9px');
    assert.equal(backing.background, 'var(--canvas-background)');
    assert.equal(backing['border-radius'], '8px');
    assert.match(backing.border, /^1px solid /);
    assert.equal(backing['pointer-events'], 'none');
    const [top, , bottom] = backing.inset.split(' ').map(Number.parseFloat);
    assert.equal(Number.parseFloat(controls.height) - top - bottom, 26, 'only the 26px pill is opaque');
    assert.equal(declarationsAt(".day-controls input[type='range']", width, height).position, 'relative', 'the native control paints above the backing');
    for (const pseudo of ['::-webkit-slider-runnable-track', '::-moz-range-track']) {
      assert.equal(declarationsAt(`.day-controls input[type='range']${pseudo}`, width, height).height, '2px');
    }
  }
});

test('CSS leaves the centered footer geometry to the studio, without a width switch', () => {
  const controls = rules.filter(rule => rule.selector === '.day-controls');
  assert.equal(controls.length, 1);
  assert.deepEqual(controls[0].media, []);
  for (const [width, height] of [[393, 747], [759, 747], [997, 747], [1009, 747], [1099, 747], [1100, 747], [1440, 900]]) {
    const value = declarationsAt('.day-controls', width, height);
    assert.equal(value.position, 'absolute');
    assert.equal(value['justify-self'], undefined);
    assert.equal(value['margin-right'], undefined);
    assert.equal(value['grid-row'], undefined);
  }
});

test('time details appear within the existing control height, without a separate action row', () => {
  for (const [width, height] of [[393, 747], [844, 390], [1100, 800], [1440, 900]]) {
    const heading = declarationsAt('.transit-controls-heading', width, height);
    assert.equal(heading.position, 'absolute');
    assert.equal(heading.height, '14px');
    assert.equal(heading.opacity, '0');
    assert.equal(heading['pointer-events'], 'none');
    assert.equal(declarationsAt('.transit-controls-heading > button', width, height).display, 'none');
    assert.equal(declarationsAt('.day-controls time', width, height)['text-overflow'], 'ellipsis');
    assert.equal(declarationsAt('.day-controls:focus-within .transit-controls-heading', width, height).opacity, '1');
  }
});

test('all viewport shapes keep the same full-width native range and permanent panel height', () => {
  for (const [width, height] of [[320, 568], [393, 747], [699, 501], [844, 390], [1009, 747], [1099, 900], [1100, 900], [1920, 1080]]) {
    const range = declarationsAt(".day-controls input[type='range']", width, height);
    assert.equal(range.height, '44px');
    assert.equal(range.width, '100%');
    assert.equal(range['touch-action'], 'none');
    assert.equal(declarationsAt('.day-controls', width, height).height, '48px');
    assert.equal(declarationsAt('.day-range', width, height).height, '44px');
    assert.equal(declarationsAt('.transit-status', width, height).position, 'absolute');
    assert.equal(declarationsAt('.transit-status:empty', width, height).display, 'none');
  }
});

test('compact range thumbs have a 44px native hit area but only a 14px crisp visible dot', () => {
  for (const [width, height, coarse] of [[320, 568, true], [699, 500, false], [824, 675, false], [844, 390, true], [1099, 900, false]]) {
    for (const pseudo of ['::-webkit-slider-thumb', '::-moz-range-thumb']) {
      const thumb = declarationsAt(`.day-controls input[type='range']${pseudo}`, width, height, { coarse });
      assert.equal(thumb.width, '44px');
      assert.equal(thumb.height, '44px');
      assert.equal(thumb.border, '0');
      assert.equal(thumb['box-shadow'], 'none');
      assert.equal(thumb.background, 'radial-gradient(circle, #8e9b8b 0 4px, #fffefa 4px 6px, #8e9b8b50 6px 7px, transparent 7px)');
      if (pseudo.includes('webkit')) assert.equal(thumb['margin-top'], '-21px');
    }
  }
});

test('integrated reference buttons and track endpoints share the native thumb travel without covering it', () => {
  for (const [rangeId, referenceId] of [['transitTime', 'transitReference'], ['chartDayTime', 'chartDayReference']]) {
    const range = byId(rangeId), reference = byId(referenceId), rail = reference.parent;
    assert.equal(rail.parent, range.parent);
    assert.equal(reference.tag, 'button');
    assert.ok(reference.attributes.includes('type="button"'));
    assert.ok(reference.attributes.includes('aria-label="'));
    assert.ok(!rail.attributes.includes('aria-hidden="true"'), 'keyboard and assistive technology can return to the reference');
    assert.ok(reference.attributes.includes('hidden'));
  }
  for (const [width, height] of [[320, 568], [393, 747], [1009, 747], [1440, 900]]) {
    const rail = declarationsAt('.day-reference-rail', width, height);
    assert.equal(rail.position, 'absolute');
    assert.equal(rail.inset, '0 22px');
    assert.equal(rail['pointer-events'], 'none');
    const wrapper = declarationsAt('.day-range', width, height);
    const margin = Number.parseFloat(wrapper['margin-inline']);
    const railInset = Number.parseFloat(rail.inset.split(' ')[1]);
    for (const pseudo of ['::-webkit-slider-thumb', '::-moz-range-thumb']) {
      const thumbWidth = Number.parseFloat(declarationsAt(`.day-controls input[type='range']${pseudo}`, width, height).width);
      assert.equal(margin, -thumbWidth / 2, 'only the invisible half-thumb areas extend past the panel');
      assert.equal(railInset, thumbWidth / 2, 'the reference rail follows the native thumb center');
    }
    assert.equal(margin + railInset, 0, 'the visible track and reference rail start at the panel edge');
    for (const panelWidth of [90, 370, 758]) {
      const nativeWidth = panelWidth - 2 * margin;
      assert.equal(nativeWidth - 2 * railInset, panelWidth, 'the visible track reaches the opposite panel edge too');
    }
    const marker = declarationsAt('.day-reference', width, height);
    assert.equal(marker['pointer-events'], 'none', 'pointer gestures stay on the native range');
    assert.equal(marker.width, '18px');
    assert.equal(marker.height, '18px');
    assert.equal(marker.top, '50%');
    assert.equal(marker.transform, 'translate(-50%, -50%)');
    for (const pseudo of ['::-webkit-slider-runnable-track', '::-moz-range-track']) {
      assert.equal(declarationsAt(`.day-controls input[type='range']${pseudo}`, width, height).background,
        'linear-gradient(to right, transparent 22px, #d9d9ce 22px, #d9d9ce calc(100% - 22px), transparent calc(100% - 22px))');
    }
  }
});

test('loading errors keep retry accessible inside the same 48px slot', () => {
  for (const [width, height] of [[320, 568], [393, 747], [844, 390], [1440, 900]]) {
    for (const status of ['loading', 'error']) {
      assert.equal(declarationsAt(`.day-controls[data-status='${status}'] .transit-controls-heading time`, width, height).display, 'none',
        'status feedback and the current time cannot occupy the same line on hover or focus');
    }
    const heading = declarationsAt(".day-controls[data-status='error'] .transit-controls-heading", width, height);
    assert.equal(heading.height, '48px');
    assert.equal(heading.opacity, '1');
    assert.equal(declarationsAt(".day-controls[data-status='error'] .day-range", width, height).visibility, 'hidden');
    const retry = declarationsAt(".day-controls[data-status='error'] .transit-controls-heading > button", width, height);
    assert.equal(retry.display, 'block');
    assert.equal(retry.height, '44px');
    assert.equal(retry['pointer-events'], 'auto');
  }
  for (const id of ['transitStatus', 'chartDayStatus']) assert.ok(byId(id).attributes.includes('role="status"'));
});

test('desktop and mobile expose identical thumb dimensions and reference styling', () => {
  for (const selector of [".day-controls input[type='range']", ".day-controls input[type='range']::-webkit-slider-thumb", ".day-controls input[type='range']::-moz-range-thumb", '.day-reference']) {
    const phone = declarationsAt(selector, 393, 747);
    for (const [width, height] of [[844, 390], [1009, 747], [1100, 500], [1440, 900], [1920, 1080]]) {
      assert.deepEqual(declarationsAt(selector, width, height), phone);
    }
  }
});

test('mandala hides a caption only when its measured clearance is insufficient', () => {
  const selector = ".studio:has(.canvas-wrap.has-mandala) .studio-header[data-mandala-overlap='true']";
  for (const [width, height] of [[393, 747], [502, 536], [967, 817], [1440, 900]]) {
    assert.equal(declarationsAt(selector, width, height).visibility, 'hidden');
    assert.equal(declarationsAt('.studio-header', width, height).visibility, undefined);
    assert.equal(declarationsAt(".studio:has(.canvas-wrap.has-mandala) .studio-header[data-caption-placement='below']", width, height).visibility,
      undefined, 'a lower caption with sufficient room remains visible');
    assert.equal(declarationsAt(".studio-header[data-mandala-overlap='true']", width, height).visibility,
      undefined, 'mandala clearance cannot hide a caption when the ring is closed');
  }
});

test('the title stays centered across portrait, landscape and toolbar breakpoints', () => {
  for (const [width, height] of [[1440, 900], [900, 800], [390, 844], [1200, 400], [568, 320], [844, 390], [1000, 500], [1001, 500]]) {
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

test('the compact mandala icon belongs to the same named, keyboard-accessible switch', () => {
  const button = byId('mandalaSwitch');
  assert.equal(button.tag, 'button', 'the native button retains Enter and Space activation');
  assert.match(button.attributes, /\btype="button"/);
  assert.match(button.attributes, /\brole="switch"/);
  assert.match(button.attributes, /\baria-label="Мандала"/, 'the icon switch retains its accessible name');
  assert.match(button.attributes, /\baria-checked="false"/, 'the existing mode controller owns the same checked state');
  assert.match(button.attributes, /\baria-controls="bodygraph"/);
  assert.doesNotMatch(button.attributes, /\btabindex="-1"/);
  const icon = nodes.find(node => node.parent === button && /\bclass="[^"]*\bmandala-switch-icon\b/.test(node.attributes));
  assert.ok(icon, 'the compact view has its own mandala illustration');
  assert.equal(icon.tag, 'svg');
  assert.match(icon.attributes, /\bwidth="24"/);
  assert.match(icon.attributes, /\bheight="24"/);
  assert.match(icon.attributes, /\baria-hidden="true"/);
  assert.match(icon.attributes, /\bfocusable="false"/, 'the decorative illustration cannot become a second focus target');
  assert.deepEqual(nodes.filter(node => node.parent === button), [icon], 'the switch contains only its mandala illustration');
  assert.doesNotMatch(page, /mandala-switch-(?:track|label)/, 'the old track and label markup are removed');
  assert.doesNotMatch(styles, /mandala-switch-(?:track|label)/, 'no unused track, label or reduced-motion rules remain');
});

test('every screen size uses the same 24px mandala illustration in a 44px button', () => {
  for (const [width, height] of [[320, 568], [359, 740], [360, 800], [360, 320], [361, 800], [390, 844], [699, 500], [700, 800], [1440, 900], [1920, 1080]]) {
    const button = declarationsAt('.mandala-switch', width, height);
    assert.equal(button.display, 'inline-flex');
    assert.equal(button.width, '44px', `${width}×${height} keeps a square touch target`);
    assert.equal(button.height, '44px');
    assert.equal(button['min-height'], '44px');
    assert.equal(button.padding, '0');
    assert.equal(button.gap, '0');
    const icon = declarationsAt('.mandala-switch-icon', width, height);
    assert.equal(icon.display, 'block');
    assert.equal(icon.width, '24px');
    assert.equal(icon.height, '24px');
  }
});

test('mandala checked styling changes its appearance without moving nearby chart tools', () => {
  const geometry = ['display', 'position', 'width', 'height', 'min-width', 'min-height', 'max-width', 'max-height',
    'padding', 'padding-inline', 'margin', 'margin-inline', 'gap', 'flex', 'flex-basis', 'order', 'transform', 'border-width'];
  const stateRules = rules.filter(rule => rule.selector.split(',').some(selector =>
    /^\.mandala-switch\[aria-checked=['"](?:true|false)['"]\](?::[\w-]+)?$/.test(selector.trim())));
  assert.ok(stateRules.length, 'the checked state has a visible treatment');
  for (const rule of stateRules) for (const property of geometry) {
    assert.equal(rule.declarations[property], undefined, `${rule.selector} cannot change ${property}`);
  }
  for (const [width, height] of [[320, 568], [360, 800], [390, 844], [1440, 900]]) {
    const toolbar = declarationsAt('.chart-tools', width, height);
    assert.equal(toolbar.position, 'fixed');
    assert.equal(toolbar.display, 'flex');
    assert.equal(toolbar.right, width <= 699 ? '10px' : '16px', 'right anchoring keeps clock and Mandala stable when Home appears on their left');
  }
});

test('clock and Mandala share the same inactive and active palettes at every layout size', () => {
  const expected = { color: '#111217', background: '#f1f3f6', 'border-color': '#cdd2dc' };
  for (const [width, height] of [[320, 568], [360, 800], [390, 844], [1440, 900]]) {
    const inactiveClock = declarationsAt('.chart-tools .icon-button', width, height);
    const inactiveMandala = declarationsAt('.mandala-switch', width, height);
    for (const property of ['color', 'background', 'border', 'border-radius']) {
      assert.equal(inactiveMandala[property], inactiveClock[property], `${width}px inactive Mandala matches the clock's ${property}`);
    }
    const clock = declarationsAt(".chart-tools .icon-button[aria-expanded='true']", width, height);
    const mandala = declarationsAt(".mandala-switch[aria-checked='true']", width, height);
    for (const [property, value] of Object.entries(expected)) {
      assert.equal(clock[property], value, `${width}px active clock defines ${property}`);
      assert.equal(mandala[property], clock[property], `${width}px active Mandala matches the clock's ${property}`);
    }
  }
});

test('hover and keyboard focus cannot make an inactive toolbar mode look active', () => {
  const activeBackground = '#f1f3f6';
  for (const rule of rules) for (const part of rule.selector.split(',')) {
    const selector = part.trim();
    if (!/:(?:hover|focus(?:-visible|-within)?)\b/.test(selector)) continue;
    if (!/^(?:button(?=[:\s])|\.icon-button(?=[:\s])|\.chart-tools\b|\.mandala-switch\b)/.test(selector)) continue;
    for (const property of ['background', 'background-color']) {
      assert.notEqual(rule.declarations[property], activeBackground, `${selector} must not claim the mode is enabled`);
    }
  }

  // These two real selectors have equal specificity (0,2,0). The later toolbar
  // default must win over the generic icon hover, not merely omit a local hover.
  const genericHover = rules.findLastIndex(rule => rule.selector === '.icon-button:hover' && rule.media.length === 0);
  const toolbarDefault = rules.findLastIndex(rule => rule.selector === '.chart-tools .icon-button' && rule.media.length === 0);
  assert.ok(genericHover >= 0, 'other interface icons retain their general hover treatment');
  assert.ok(toolbarDefault > genericHover, 'an inactive toolbar button overrides the general hover background');
  for (const [width, height] of [[320, 568], [360, 800], [390, 844], [1440, 900]]) {
    assert.equal(declarationsAt('.chart-tools .icon-button', width, height).background, 'var(--canvas-background)');
    assert.equal(declarationsAt('.mandala-switch', width, height).background, 'var(--canvas-background)');
    const focus = declarationsAt('.chart-tools button:focus-visible', width, height);
    assert.equal(focus.outline, '1px dashed #566b89', 'keyboard focus has a distinct outline instead of a selected fill');
    assert.equal(focus['outline-offset'], '2px');
    assert.equal(focus.background, undefined);
    assert.equal(focus['background-color'], undefined);
  }
});

test('caption fit can move a centered title below the tools without a landscape-specific left shift', () => {
  const belowRule = rules.find(rule => /^\.studio-header\[data-caption-placement=['"]below['"]\]$/.test(rule.selector));
  assert.ok(belowRule, 'measured caption fit has a placement state');
  assert.deepEqual(belowRule.media, [], 'caption fit does not depend on a viewport breakpoint');
  assert.equal(belowRule.declarations.top, 'var(--caption-below-top, 65px)');
  for (const property of ['left', 'right', 'width', 'transform', 'text-align']) {
    assert.equal(belowRule.declarations[property], undefined, `placing below does not change ${property}`);
  }
  for (const [width, height] of [[320, 568], [568, 320], [844, 390], [1000, 500], [1001, 500], [1440, 900]]) {
    const heading = declarationsAt('.studio-header', width, height);
    assert.equal(heading.left, '50%');
    assert.equal(heading.transform, 'translateX(-50%)');
    assert.equal(heading['text-align'], 'center');
    assert.equal(heading.width, 'var(--caption-width, calc(100% - 32px))', 'the measured free width controls truncation');
    assert.equal(declarationsAt('.studio-header .chart-heading', width, height)['align-items'], 'center');
    assert.equal(declarationsAt('.studio-header .chart-title-row', width, height)['justify-content'], 'center');
    const below = { ...heading, ...declarationsAt(belowRule.selector, width, height) };
    assert.equal(below.left, heading.left);
    assert.equal(below.transform, heading.transform);
    assert.equal(below.width, heading.width);
  }
});

test('all chart controls fit beside Menu at the narrowest phone size', () => {
  for (const [width, height] of [[320, 568], [359, 740], [393, 747]]) {
    const toolbar = declarationsAt('.chart-tools', width, height);
    const icon = declarationsAt('.chart-tools .icon-button', width, height);
    const mandala = declarationsAt('.mandala-switch', width, height);
    assert.equal(icon.width, '44px');
    assert.equal(icon.height, '44px');
    const toolbarWidth = 4 * Number.parseFloat(icon.width) + Number.parseFloat(mandala.width) + 4 * Number.parseFloat(toolbar.gap);
    const menu = declarationsAt('.topbar', width, height);
    const menuButton = declarationsAt('.topbar .icon-button', width, height);
    const menuRight = Number.parseFloat(menu.left) + Number.parseFloat(menuButton.width);
    assert.ok(width - Number.parseFloat(toolbar.right) - toolbarWidth - menuRight >= 12, '44px targets keep a visible gap beside Menu, including when Home is visible');
  }
});

test('printing hides both day sliders and restores the full print drawing height', () => {
  const printBlocks = [...styles.matchAll(/@media print\s*\{(?:[^{}]|\{[^{}]*\})*\}/g)].map(match => match[0]).join('\n');
  assert.match(printBlocks, /\.day-controls\s*\{[^}]*display:\s*none\s*!important/);
  assert.match(printBlocks, /\.studio\s*>\s*\.canvas-wrap\s*\{[^}]*height:\s*260mm/);
  assert.doesNotMatch(printBlocks, /mask-image|mask-composite|backdrop-filter|blur\(/);
});
