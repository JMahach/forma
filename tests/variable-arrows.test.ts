import type { ChartView } from '../src/domain/chart-composition.ts';
import type { RenderOptions } from '../src/scene/render-state.ts';
import type { Activation, ChartData } from '../shared/chart-types.ts';
interface SvgTree { name: string; attrs: Record<string, string>; children: SvgTree[]; text: string }
interface Bounds { left: number; right: number; top: number; bottom: number }
interface ExpectedVariable { id: string; source: 'design' | 'personality'; columnSide: string; position: string; x: number; y: number; label: string; pair: string[] }
import test from 'node:test';
import assert from 'node:assert/strict';
import { activationDetails } from '../src/views/activation-details.ts';
import { PLANETS } from '../src/domain/planets.ts';
import { renderActivationColumns } from '../src/scene/activation-columns.ts';
import { renderVariableArrows, visibleVariables } from '../src/scene/variable-arrows.ts';
import { calculateVariables } from '../src/domain/variables.ts';
import { overlayFixture } from './helpers/chart-composition.ts';
import { renderBodygraph } from '../src/scene/bodygraph-svg.ts';
import { CENTERS, GATES, CHANNELS } from '../src/scene/geometry/chart-geometry.ts';

// Expected roles and layout are independent of the Variable calculator/renderer.
const EXPECTED: ExpectedVariable[] = [
  { id: 'determination', source: 'design' as const, columnSide: 'left', position: 'top', x: 148, y: 134, label: 'Детерминация', pair: ['sun', 'earth'] },
  { id: 'environment', source: 'design' as const, columnSide: 'left', position: 'bottom', x: 148, y: 206, label: 'Среда', pair: ['north_node', 'south_node'] },
  { id: 'awareness', source: 'personality' as const, columnSide: 'right', position: 'top', x: 492, y: 134, label: 'Осознанность', pair: ['sun', 'earth'] },
  { id: 'perspective', source: 'personality' as const, columnSide: 'right', position: 'bottom', x: 492, y: 206, label: 'Перспектива', pair: ['north_node', 'south_node'] },
];
const GLYPH_SCALE = 1.3;
const BLOCK_SCALE = 1.09;
const BLOCK_LIFT = 15.75;
const BLOCK_PIVOT: Record<string, number> = { left: 212, right: 428 };
const COLOR: Record<string, string> = { design: '#c32d35', personality: '#202020' };
const SOURCE_LABEL: Record<string, string> = { design: 'Дизайн', personality: 'Личность' };
const attributes = (tag: string) => Object.fromEntries([...tag.matchAll(/([\w:-]+)="([^"]*)"/g)].map(([, key, value]) => [key, value]));
const hasClass = (node: Pick<SvgTree, 'attrs'>, name: string) => (node.attrs.class || '').split(/\s+/).includes(name);

function assertBlockTransform(node: Pick<SvgTree, 'attrs'>, columnSide: string) {
  const pivot = BLOCK_PIVOT[columnSide];
  assert.ok(pivot, 'every content wrapper belongs to a known column side');
  assert.equal(node.attrs.transform, `translate(${pivot} 60.25) scale(1.09) translate(${-pivot} -76)`,
    'the whole column block keeps its approved scale and rises 15.75 drawing units');
}

function columnContent(column: SvgTree) {
  assert.equal(column.children.length, 1, 'one common wrapper scales heading, rule, rows and hit targets together');
  const content = column.children[0];
  assert.equal(content.name, 'g');
  assert.ok(hasClass(content, 'activation-block-content'));
  assert.equal(content.attrs['data-column-side'], undefined, 'the outer column owns its movement');
  assertBlockTransform(content, column.attrs['data-column-side']);
  return content;
}

function variableContent(root: SvgTree) {
  return root.children.map(wrapper => {
    assert.equal(wrapper.name, 'g');
    assert.ok(hasClass(wrapper, 'variable-block'));
    assert.equal(wrapper.children.length, 1, 'each existing heading or Variable group is preserved as one complete child');
    const child = wrapper.children[0], source = child.attrs['data-source'];
    assert.equal(wrapper.attrs['data-column-side'], EXPECTED.find(value => value.source === source)!.columnSide);
    assert.equal(wrapper.attrs['data-source'], undefined, 'source belongs to the content, not its movement wrapper');
    assertBlockTransform(wrapper, wrapper.attrs['data-column-side']);
    return child;
  });
}

function blockBounds<T extends Bounds>(bounds: T, columnSide: string): T {
  const x = BLOCK_PIVOT[columnSide];
  return { ...bounds, left: x + (bounds.left - x) * BLOCK_SCALE, right: x + (bounds.right - x) * BLOCK_SCALE,
    top: 76 + (bounds.top - 76) * BLOCK_SCALE - BLOCK_LIFT, bottom: 76 + (bounds.bottom - 76) * BLOCK_SCALE - BLOCK_LIFT };
}

function chartFor(tones: readonly number[] = [1, 2, 3, 6], colors: readonly number[] = [1, 2, 4, 6]) {
  const activations: Record<'design' | 'personality', Activation[]> = { design: [], personality: [] };
  EXPECTED.forEach((variable, index) => {
    // Sun/Earth and the nodes are opposite pairs from the existing gate wheel.
    const nodePair = variable.position === 'bottom';
    const gatePair = nodePair ? [19, 33] : [41, 31];
    const start = nodePair ? 307.625 : 302;
    variable.pair.forEach((planet, side) => {
      // Inside line 2, with half of the requested Tone completed.
      const longitude = (start + side * 180 + 0.9375 + (colors[index] - 1) * 0.15625 + (tones[index] - 0.5) * (5 / 192)) % 360;
      const entry = { planet, gate: gatePair[side], line: 2, longitude };
      const details = activationDetails(entry);
      assert.equal(details?.find(row => row.key === 'tone')?.value, tones[index], 'fixture Tone follows the existing longitude subdivision');
      assert.equal(details?.find(row => row.key === 'color')?.value, colors[index], 'fixture Color follows the existing longitude subdivision');
      activations[variable.source].push(entry);
    });
  });
  return { source: 'calculated' as ChartData['source'], personality: activations.personality.map(entry => entry.gate), design: activations.design.map(entry => entry.gate), activations };
}

test('a prepared domain snapshot produces the exact chart API markup without rereading mutable input', () => {
  for (let color = 1; color <= 6; color++) {
    for (let tone = 1; tone <= 6; tone++) {
      const chart = chartFor([tone, tone, tone, tone], [color, color, color, color]);
      const expected = renderVariableArrows(chart), variables = calculateVariables(chart);
      assert.equal(renderVariableArrows(chart, variables), expected);
      chart.activations.design.length = 0;
      assert.equal(renderVariableArrows(chart as ChartView), '');
      assert.equal(renderVariableArrows(chart, variables), expected, 'format the prepared snapshot instead of calculating it again');
    }
  }
  assert.equal(renderVariableArrows(chartFor(), []), '', 'an explicitly absent prepared state stays absent');
});

test('the shared Variable visibility rule avoids domain reads in hidden modes', () => {
  const chart = chartFor();
  assert.deepEqual(visibleVariables(chart, { showActivations: true }), calculateVariables(chart));
  let reads = 0;
  Object.defineProperty(chart, 'activations', { get() { reads++; throw new Error('hidden Variables must not inspect activations'); } });
  for (const options of [{}, { showActivations: false }, { showActivations: true, showMandala: true }] as const) {
    assert.deepEqual(visibleVariables(chart, options), []);
  }
  const overlay = overlayFixture(chart, chartFor(), { kind: 'return' as const, event: { id: 'fixture-return', body: 'saturn', cycle: 1 } });
  assert.deepEqual(visibleVariables(overlay, { showActivations: true }), []);
  assert.equal(reads, 0);
  assert.doesNotMatch(renderBodygraph(chartFor(), null, { profile: 'thumbnail', showActivations: true }), /bodygraph-variables/);
});

test('direct Variable formatting suppresses return and transit compositions', () => {
  const chart = chartFor();
  for (const options of [{ kind: 'return' as const, event: { id: 'fixture-return', body: 'saturn', cycle: 1 } }, { kind: 'transit' as const }] as const) {
    const overlay = overlayFixture(chart, chart, options);
    assert.equal(Boolean(renderVariableArrows(overlay)), false, 'an overlay never borrows the primary chart Variable decoration');
  }
});

function parseSvg(markup: string) {
  const document = { children: [] } as unknown as SvgTree, stack = [document];
  for (const [token] of markup.matchAll(/<[^>]+>|[^<]+/g)) {
    if (!token.startsWith('<')) { if (stack.at(-1)!.text !== undefined) stack.at(-1)!.text += token; continue; }
    if (token.startsWith('</')) {
      const node = stack.pop();
      assert.equal(node?.name, token.match(/^<\/([\w:-]+)/)?.[1], 'SVG element nesting is balanced');
      continue;
    }
    const node: SvgTree = { name: token.match(/^<([\w:-]+)/)![1], attrs: attributes(token), children: [], text: '' };
    assert.ok(node.name, 'markup contains ordinary SVG elements');
    stack.at(-1)!.children.push(node);
    if (!token.endsWith('/>')) stack.push(node);
  }
  assert.equal(stack.length, 1, 'every SVG element closes');
  assert.equal(document.children.length, 1, 'the renderer returns one complete SVG group');
  return document.children[0];
}

function arrows(markup: string) {
  const root = parseSvg(markup);
  assert.equal(root.name, 'g');
  assert.ok(hasClass(root, 'bodygraph-variables'));
  assert.equal(root.attrs['pointer-events'], 'none');
  assert.equal(root.children.length, 6, 'two heading groups precede four Variable groups');
  const children = variableContent(root);
  children.slice(0, 2).forEach(node => assert.ok(hasClass(node, 'bodygraph-variable-headings')));
  return children.slice(2).map(node => {
    assert.equal(node.name, 'g');
    assert.ok(hasClass(node, 'bodygraph-variable'));
    const glyphs = node.children.filter((child: { name: string; }) => child.name === 'g');
    assert.equal(glyphs.length, 2, 'each Variable contains one Color and one Tone glyph');
    const readGlyph = (name: string, shift: number) => {
      const matches = glyphs.filter(glyph => hasClass(glyph, name));
      assert.equal(matches.length, 1);
      const glyph = matches[0];
      assert.equal(glyph.attrs.transform, 'translate(' + shift + ' 0) scale(1.3)');
      const paths = glyph.children.filter((child: { name: string; }) => child.name === 'path');
      const texts = glyph.children.filter((child: { name: string; }) => child.name === 'text');
      assert.equal(paths.length, 1);
      assert.equal(texts.length, 1);
      assert.equal(glyph.children.length, 2, 'only a polygon and its number belong to each glyph');
      return { node: glyph, path: paths[0].attrs, number: texts[0], shift };
    };
    return { attrs: node.attrs, color: readGlyph('variable-color', -36), tone: readGlyph('variable-tone', 36) };
  });
}

// Read the closed polygon so incorrect directions cannot pass by changing only
// data attributes. Its single extreme tip, shoulders and tail determine direction.
function polygonPoints(path: string): number[][] {
  const tokens = path.match(/[A-Za-z]|-?(?:\d*\.\d+|\d+)(?:e[-+]?\d+)?/g) || [];
  const points: number[][] = [];
  let index = 0, command: string = '', point: number[] | undefined, closed = false;
  const number = () => {
    const value = Number(tokens[index++]);
    assert.ok(Number.isFinite(value), 'glyph polygon coordinates are finite');
    return value;
  };
  while (index < tokens.length) {
    if (/^[A-Za-z]$/.test(tokens[index])) command = tokens[index++];
    if (command === 'Z') { closed = true; assert.equal(index, tokens.length); break; }
    assert.ok(['M', 'L', 'H', 'V'].includes(command), 'glyph uses straight polygon edges');
    point = command === 'H' ? [number(), point![1]] : command === 'V' ? [point![0], number()] : [number(), number()];
    points.push(point);
    if (command === 'M') command = 'L';
  }
  assert.ok(closed, 'filled arrow polygon is explicitly closed');
  return points;
}

function assertTip(path: string, direction: string) {
  const points = polygonPoints(path);
  const axis = ['left', 'right'].includes(direction) ? 0 : 1, across = 1 - axis;
  const sign = ['left', 'up'].includes(direction) ? -1 : 1;
  const extrema = points.map(point => point[axis] * sign);
  assert.equal(Math.max(...extrema), 21, 'the arrow tip reaches 21 units toward its direction');
  assert.equal(Math.min(...extrema), -19, 'the opposite tail ends at 19 units');
  assert.equal(Math.min(...points.map(point => point[across])), -20);
  assert.equal(Math.max(...points.map(point => point[across])), 20);
  const tips = points.map((point, index) => ({ point, index })).filter(({ point }) => point[axis] === sign * 21);
  assert.equal(tips.length, 1, 'one extreme vertex identifies the arrow tip');
  const { point: tip, index } = tips[0];
  assert.equal(tip[across], 0, 'the tip lies on the glyph axis');
  const neighbors = [points[(index + points.length - 1) % points.length], points[(index + 1) % points.length]];
  assert.ok(neighbors.every(point => point[axis] * sign < 21), 'both shoulders recede behind the tip');
  assert.ok(neighbors[0][across] * neighbors[1][across] < 0, 'the tip connects opposite shoulders');
}

function glyphBounds(glyph: ReturnType<typeof arrows>[number]['color'], origin: ExpectedVariable) {
  const radius = Number(glyph.path['stroke-width']) * GLYPH_SCALE / 2;
  assert.ok(Number.isFinite(radius) && radius > 0);
  const points = polygonPoints(glyph.path.d).map(point => point.map(value => value * GLYPH_SCALE));
  return blockBounds({ left: origin.x + glyph.shift + Math.min(...points.map(point => point[0])) - radius, right: origin.x + glyph.shift + Math.max(...points.map(point => point[0])) + radius, top: origin.y + Math.min(...points.map(point => point[1])) - radius, bottom: origin.y + Math.max(...points.map(point => point[1])) + radius }, origin.columnSide);
}

const HORIZONTAL_RULE = /^M\s*(-?[\d.]+)[,\s]+(-?[\d.]+)\s*([Hh])\s*(-?[\d.]+)$/;

function horizontalRule(path: Record<string, string>) {
  const match = path.d.match(HORIZONTAL_RULE);
  assert.ok(match, 'a heading underline is one straight horizontal segment');
  const start = Number(match![1]), y = Number(match![2]);
  const end = Number(match![4]) + (match![3] === 'h' ? start : 0);
  assert.ok(start < end);
  return { start, end, y };
}

function assertHeaderRule(node: SvgTree, className: string, source: string, start: number, end: number) {
  assert.equal(node.name, 'path');
  assert.ok(hasClass(node, className));
  assert.deepEqual(horizontalRule(node.attrs), { start, end, y: 88 }, 'each rule keeps its approved horizontal span and original vertical offset');
  assert.equal(node.attrs.fill, 'none');
  assert.equal(node.attrs.stroke, COLOR[source]);
  assert.equal(Number(node.attrs['stroke-opacity']), 0.18);
  assert.equal(Number(node.attrs['stroke-width']), 1);
  assert.equal(node.attrs.transform, undefined, 'the rule keeps its unscaled coordinates');
}

function assertArrow(arrow: ReturnType<typeof arrows>[number], expected: ExpectedVariable, tone: number, color: number) {
  const { attrs } = arrow;
  const direction = tone <= 3 ? 'left' : 'right';
  // Official Maia Mechanics treats these as independent thresholds:
  // Color 1–3 points down / 4–6 up; Tone 1–3 points left / 4–6 right.
  const colorDirection = color <= 3 ? 'down' : 'up';
  assert.equal(attrs['data-variable'], expected.id);
  assert.equal(attrs['data-source'], expected.source);
  assert.equal(attrs['data-position'], expected.position);
  assert.equal(attrs['data-tone'], String(tone));
  assert.equal(attrs['data-color'], String(color));
  assert.equal(attrs['data-direction'], direction);
  assert.equal(attrs['data-color-direction'], colorDirection);
  assert.equal(attrs.transform, 'translate(' + expected.x + ' ' + expected.y + ')');
  assert.equal(attrs.role, 'img');
  for (const text of [SOURCE_LABEL[expected.source], expected.label, direction === 'left' ? 'влево' : 'вправо', colorDirection === 'up' ? 'вверх' : 'вниз', 'тон ' + tone, 'цвет ' + color] as const) {
    assert.ok(attrs['aria-label']?.includes(text), 'accessible label includes ' + text);
  }
  assert.equal(arrow.color.path.fill, '#ffffff');
  assert.equal(arrow.color.path.stroke, COLOR[expected.source]);
  assert.equal(arrow.tone.path.fill, COLOR[expected.source]);
  assert.equal(arrow.color.number.attrs.fill, COLOR[expected.source]);
  assert.equal(arrow.tone.number.attrs.fill, '#ffffff');
  for (const [glyph, value] of [[arrow.color, color], [arrow.tone, tone]] as const) {
    assert.equal(glyph.number.text.trim(), String(value), 'the number matches its own saved subdivision');
    assert.equal(glyph.number.attrs['font-size'], '18');
    assert.equal(glyph.number.attrs['text-anchor'], 'middle');
    assert.equal(glyph.path['stroke-width'], '1.25', 'the original local stroke scales with the complete glyph');
    assert.notEqual(glyph.path['vector-effect'], 'non-scaling-stroke');
    assert.equal(glyph.path.transform, undefined, 'polygon has no separate transform that could cancel the shared scale');
    assert.equal(glyph.number.attrs.transform, undefined, 'number receives the same 30% enlargement');
    assert.ok(Math.abs(Number(glyph.number.attrs['font-size']) * GLYPH_SCALE - 23.4) < 1e-12);
    assert.equal(Number(glyph.path['stroke-width']) * GLYPH_SCALE, 1.625);
  }
  assertTip(arrow.tone.path.d, direction);
  assertTip(arrow.color.path.d, colorDirection);
}

test('Color and Tone headings retain colors and positions with one connected rule on each side', () => {
  const root = parseSvg(renderVariableArrows(chartFor()));
  const headings = variableContent(root).filter(node => hasClass(node, 'bodygraph-variable-headings'));
  assert.equal(headings.length, 2);
  for (const [index, source] of ['design', 'personality'].entries()) {
    const heading = headings[index];
    assert.equal(heading.attrs['data-source'], source);
    assert.equal(heading.attrs['aria-hidden'], 'true');
    assert.equal(heading.attrs.fill, COLOR[source]);
    assert.equal(heading.children.length, 3, 'two labels share exactly one connecting rule on each side');
    const texts = heading.children.filter((node: { name: string; }) => node.name === 'text');
    assert.equal(texts.length, 2);
    const xs = source === 'design' ? [112, 184] : [456, 528];
    texts.forEach((node, column) => {
      assert.equal(node.name, 'text');
      assert.ok(hasClass(node, 'activation-heading'));
      assert.equal(node.text.trim(), ['Цвет', 'Тон'][column]);
      assert.equal(node.attrs.x, String(xs[column]));
      assert.equal(node.attrs.y, '76');
      assert.equal(node.attrs['font-size'], '16');
      assert.equal(node.attrs['font-weight'], '500');
      assert.equal(node.attrs['text-anchor'], 'middle');
    });
    const rules = heading.children.filter((node: { name: string; }) => node.name === 'path');
    assert.equal(rules.length, 1);
    assertHeaderRule(rules[0], 'variable-header-rule', source, source === 'design' ? 84 : 428, source === 'design' ? 212 : 556);
  }
});

test('calculated, manual and transit headings retain only the approved rule spans without extra paths or duplicates', () => {
  const chart = chartFor();
  for (const source of ['calculated', 'manual', 'transit'] as const) {
    const current = { ...chart, source, ...(source === 'transit' ? { design: [], activations: { ...chart.activations, design: [] } } : {}) };
    const columnMarkup = renderActivationColumns(current);
    const columns = columnMarkup ? parseSvg(columnMarkup).children : [];
    assert.deepEqual(columns.map(node => node.attrs['data-source']), source === 'manual' ? [] : source === 'transit' ? ['personality'] : ['design', 'personality']);
    for (const column of columns) {
      const side = column.attrs['data-source'];
      assert.ok(hasClass(column, 'activation-column'));
      assert.equal(column.attrs.fill, COLOR[side]);
      const content = columnContent(column);
      const headings = content.children.filter((node: { name: string; }) => node.name === 'text');
      assert.equal(headings.length, 1, 'each calculation column has exactly one heading');
      const heading = headings[0];
      assert.ok(hasClass(heading, 'activation-heading'));
      assert.equal(heading.text.trim(), side === 'design' ? 'Дизайн' : source === 'transit' ? 'Транзит' : 'Личность');
      assert.equal(heading.attrs.x, side === 'design' ? '-50' : '598');
      assert.equal(heading.attrs.y, '76');
      assert.equal(heading.attrs['font-size'], '16');
      assert.equal(heading.attrs['font-weight'], '500');
      assert.equal(heading.attrs['text-anchor'] ?? 'start', 'start');
      const rules = content.children.filter((node: { name: string; }) => node.name === 'path');
      assert.equal(rules.length, 1, 'each calculation heading has exactly one full panel separator');
      const start = side === 'design' ? -60 : 588;
      const width = 130;
      assertHeaderRule(rules[0], 'activation-header-rule', side, start, start + width);
      const panels = content.children.filter(node => hasClass(node, 'activation-panel'));
      assert.equal(panels.length, 1, 'one compact frame surrounds each calculation column');
      assert.equal(panels[0].name, 'rect');
      assert.equal(panels[0].attrs['pointer-events'], 'none');
      assert.ok(content.children.every(node => node === panels[0] || node === heading || node === rules[0] || hasClass(node, 'activation-row')), 'the frame, heading, full separator and calculation rows belong to the column');
    }
    const full = renderBodygraph(current, null, { showActivations: true });
    const headings = [...full.matchAll(/<text\b[^>]*>/g)].filter(([tag]) => hasClass({ attrs: attributes(tag) }, 'activation-heading'));
    const expectedCount = source === 'calculated' ? 6 : source === 'manual' ? 0 : 1;
    assert.equal(headings.length, expectedCount, 'each visible word retains exactly one heading, including transit');
    const paths = [...full.matchAll(/<path\b[^>]*>/g)].map(([tag]) => ({ attrs: attributes(tag) }));
    const rules = paths.filter(node => hasClass(node, 'activation-header-rule') || hasClass(node, 'variable-header-rule'));
    assert.equal(rules.length, source === 'calculated' ? 4 : expectedCount, 'each connected rule replaces its separate Color/Tone rules without duplication');
    assert.equal(rules.filter(node => hasClass(node, 'variable-header-rule')).length, source === 'calculated' ? 2 : 0);
    const horizontalPathsAtHeading = paths.filter(node => {
      const match = node.attrs.d?.match(HORIZONTAL_RULE);
      return match && Number(match[2]) === 88;
    });
    assert.deepEqual(horizontalPathsAtHeading, rules, 'no former long divider or head-reaching extension survives at y=88, even without a rule class');
    const spans = rules.map(node => {
      const { start, end } = horizontalRule(node.attrs);
      return [start, end];
    }).sort((a, b) => a[0] - b[0]);
    assert.deepEqual(spans, source === 'calculated'
      ? [[-60, 70], [84, 212], [428, 556], [588, 718]]
      : source === 'manual' ? [] : [[588, 718]], 'separate rules cover each panel and each Color/Tone pair; manual charts omit their rules');
    if (source !== 'calculated') assert.equal(renderVariableArrows(current), '');
    assert.doesNotMatch(renderBodygraph(current), /activation-heading|activation-header-rule|variable-header-rule/, 'hidden activation columns also omit their headings and short rules');
  }
});

test('source panels and Color/Tone rules retain visible gaps and stop short of the centers', () => {
  const chart = chartFor();
  const headings = variableContent(parseSvg(renderVariableArrows(chart))).filter(node => hasClass(node, 'bodygraph-variable-headings'));
  const columns = parseSvg(renderActivationColumns(chart)).children;
  for (const expected of [
    { source: 'design' as const, columnSide: 'left', extension: [84, 212], underline: [-60, 70], gap: 14, anchors: [-50, 112, 184] },
    { source: 'personality' as const, columnSide: 'right', extension: [428, 556], underline: [588, 718], gap: 32, anchors: [456, 528, 598] },
  ] as const) {
    const heading = headings.find((node: { attrs: { [x: string]: string; }; }) => node.attrs['data-source'] === expected.source);
    const column = columns.find((node: { attrs: { [x: string]: string; }; }) => node.attrs['data-source'] === expected.source);
    const extension = heading!.children.find(node => hasClass(node, 'variable-header-rule'));
    const underline = columnContent(column!).children.find(node => hasClass(node, 'activation-header-rule'));
    assertHeaderRule(extension!, 'variable-header-rule', expected.source, expected.extension[0], expected.extension[1]);
    assertHeaderRule(underline!, 'activation-header-rule', expected.source, expected.underline[0], expected.underline[1]);
    const [left, right] = [horizontalRule(extension!.attrs), horizontalRule(underline!.attrs)].sort((a, b) => a.start - b.start);
    assert.equal(right.start - left.end, expected.gap, 'the independent segments have a visible gap');
    const panel = columnContent(column!).children.find(node => hasClass(node, 'activation-panel'))!;
    assert.equal(Number(panel.attrs.x), expected.underline[0]);
    assert.equal(Number(panel.attrs.x) + Number(panel.attrs.width), expected.underline[1], 'the separator reaches both frame sides');
    assert.equal(Math.max(0, Math.min(left.end, right.end) - Math.max(left.start, right.start)), 0, 'no shared interval receives a second translucent stroke');
    for (const node of [extension, underline] as const) assert.equal(node!.attrs['stroke-linecap'] ?? 'butt', 'butt', 'neither segment extends its cap into the gap');
    for (const x of expected.anchors) assert.ok([left, right].some(span => span.start <= x && x < span.end), 'every heading remains over its own separator');
    for (const id of ['head', 'ajna'] as const) {
      const center = CENTERS.find(center => center.id === id);
      const xs = center!.points.split(/\s+/).map(pair => Number(pair.split(',')[0]));
      const bounds = blockBounds({ left: left.start - .5, right: right.end + .5, top: 87.5, bottom: 88.5 }, expected.columnSide);
      const clear = expected.columnSide === 'left'
        ? bounds.right < Math.min(...xs) - 1.25 / 2
        : bounds.left > Math.max(...xs) + 1.25 / 2;
      assert.ok(clear, expected.source + ' rule and its stroke remain outside the full ' + id + ' center width, not extended toward its edge');
    }
  }
});

test('raising the source blocks preserves their size and the gaps between independent rules', () => {
  const chart = chartFor();
  const columns = parseSvg(renderActivationColumns(chart)).children;
  const variables = parseSvg(renderVariableArrows(chart));
  const project = (wrapper: SvgTree, point: { x: number; y: number }) => {
    const match = wrapper.attrs.transform.match(/^translate\((-?[\d.]+) (-?[\d.]+)\) scale\(([\d.]+)\) translate\((-?[\d.]+) (-?[\d.]+)\)$/);
    assert.ok(match, 'the actual block transform consists of translations and one uniform scale');
    const [x, y, scale, localX, localY] = match.slice(1).map(Number);
    return { x: (point.x + localX) * scale + x, y: (point.y + localY) * scale + y };
  };
  for (const column of columns) {
    const columnSide = column.attrs['data-column-side'], pivot = BLOCK_PIVOT[columnSide];
    const content = columnContent(column);
    const siblings = variables.children.filter(node => node.attrs['data-column-side'] === columnSide);
    assert.equal(siblings.length, 3, 'the heading and both Variable rows share the same lift as their calculation column');
    const points = [{ x: pivot - 40, y: 76 }, { x: pivot + 80, y: 716 }];
    for (const wrapper of [content, ...siblings] as const) {
      const actual = points.map(point => project(wrapper, point));
      points.forEach((point, index) => {
        const previous = { x: pivot + (point.x - pivot) * 1.09, y: 76 + (point.y - 76) * 1.09 };
        assert.ok(Math.abs(actual[index].x - previous.x) < 1e-9, 'the horizontal geometry does not change');
        assert.ok(Math.abs(actual[index].y - previous.y + BLOCK_LIFT) < 1e-9, 'the lift is 15.75 drawing units, without multiplying it by the block scale');
      });
      assert.ok(Math.abs(actual[1].x - actual[0].x - 120 * 1.09) < 1e-9, 'block width retains its approved scale');
      assert.ok(Math.abs(actual[1].y - actual[0].y - 640 * 1.09) < 1e-9, 'block height retains its approved scale');
    }
    const headingWrapper = siblings.find(node => hasClass(node.children[0], 'bodygraph-variable-headings'));
    const extension = horizontalRule(headingWrapper!.children[0].children.find(node => hasClass(node, 'variable-header-rule'))!.attrs);
    const underline = horizontalRule(content.children.find(node => hasClass(node, 'activation-header-rule'))!.attrs);
    const ends = columnSide === 'left'
      ? [{ x: extension.start, y: extension.y }, { x: underline.end, y: underline.y }]
      : [{ x: extension.end, y: extension.y }, { x: underline.start, y: underline.y }];
    const pairEnd = project(headingWrapper!, ends[0]), panelEnd = project(content, ends[1]);
    assert.equal(pairEnd.y, panelEnd.y, 'both separators retain the same vertical alignment');
    assert.ok(Math.abs(Math.abs(pairEnd.x - panelEnd.x) - (columnSide === 'left' ? 14 : 32) * BLOCK_SCALE) < 1e-9, 'the visible gap receives the same block scale');
  }
});

test('all 16 Tone direction combinations retain four independent Color/Tone pairs, positions and labels', () => {
  const colors = [1, 2, 4, 6];
  for (let state = 0; state < 16; state++) {
    const tones = EXPECTED.map((_, index) => state & (1 << index) ? 4 + index % 3 : 1 + index % 3);
    const rendered = arrows(renderVariableArrows(chartFor(tones, colors)));
    assert.deepEqual(rendered.map(arrow => arrow.attrs['data-variable']), EXPECTED.map(variable => variable.id));
    rendered.forEach((arrow, index) => assertArrow(arrow, EXPECTED[index], tones[index], colors[index]));
  }
});

test('all six Colors and all six Tones retain separate saved numbers and correct polygon directions', () => {
  for (let color = 1; color <= 6; color++) for (let tone = 1; tone <= 6; tone++) {
    arrows(renderVariableArrows(chartFor([tone, tone, tone, tone], [color, color, color, color])))
      .forEach((arrow, index) => assertArrow(arrow, EXPECTED[index], tone, color));
  }
});

test('manual, transit, incomplete and inconsistent charts never render partial or invented Color/Tone glyphs', () => {
  const valid = chartFor();
  for (const chart of [undefined, null, {}, { source: 'calculated' as const },
    { ...valid, source: 'manual' as const }, { ...valid, source: 'transit' as const }, { ...valid, source: undefined },
    { ...valid, activations: { design: valid.activations.design } },
    { ...valid, activations: { personality: valid.activations.personality } }] as const) assert.equal(renderVariableArrows(chart as ChartView), '');
  for (const source of ['design', 'personality'] as const) for (let index = 0; index < 4; index++) {
    for (const change of [
      (chart: ReturnType<typeof chartFor>) => chart.activations[source].splice(index, 1),
      (chart: ReturnType<typeof chartFor>) => { delete (chart.activations[source][index] as Partial<Activation>).longitude; },
      (      chart: { activations: { [x: string]: { longitude: number; }[]; }; }) => { chart.activations[source][index].longitude = NaN; },
      (      chart: { activations: { [x: string]: { line: number; }[]; }; }) => { chart.activations[source][index].line = 3; },
      (chart: ReturnType<typeof chartFor>) => chart.activations[source].push({ ...chart.activations[source][index] }),
      (      chart: { activations: { [x: string]: { longitude: number; }[]; }; }) => { chart.activations[source][index].longitude += 5 / 192; },
      (      chart: { activations: { [x: string]: { longitude: number; }[]; }; }) => { chart.activations[source][index].longitude += 0.15625; },
    ] as const) {
      const malformed = structuredClone(valid);
      change(malformed);
      assert.equal(renderVariableArrows(malformed), '', source + '/' + index + ': one invalid or disagreeing pair suppresses the complete layer');
    }
  }
});

test('both glyph polygons and their stroke edges stay outside every center and gate hit area', () => {
  const boxes = CENTERS.map(center => {
    const points = center.points.split(/\s+/).map(pair => pair.split(',').map(Number));
    return { id: center.id, left: Math.min(...points.map(point => point[0])), right: Math.max(...points.map(point => point[0])), top: Math.min(...points.map(point => point[1])), bottom: Math.max(...points.map(point => point[1])) };
  });
  for (const colors of [[1, 1, 1, 1], [6, 6, 6, 6]] as const) for (const tones of [[1, 1, 1, 1], [6, 6, 6, 6]] as const) {
    arrows(renderVariableArrows(chartFor(tones, colors))).forEach((arrow, index) => {
      const expected = EXPECTED[index], bounds = [];
      for (const glyph of [arrow.color, arrow.tone] as const) {
        const box = glyphBounds(glyph, expected);
        bounds.push(box);
        const disjoint = (other: Bounds) => box.right < other.left || box.left > other.right || box.bottom < other.top || box.top > other.bottom;
        boxes.forEach(other => assert.ok(disjoint(other), expected.id + ' clears the complete ' + other.id + ' center bounds'));
        GATES.forEach(gate => assert.ok(disjoint({ left: gate.x - 12.5, right: gate.x + 12.5, top: gate.y - 12.5, bottom: gate.y + 12.5 }), expected.id + ' clears gate ' + gate.id + "'s existing hit area"));
      }
      assert.ok(bounds[0].right < bounds[1].left, 'Color and Tone glyphs do not overlap each other');
    });
  }
});

test('all eight enlarged glyphs keep positive stroke-inclusive spacing from one another', () => {
  const gap = (a: { left: number; right: number; top: number; bottom: number; }, b: { right: number; left: number; bottom: number; top: number; }) => Math.hypot(Math.max(a.left - b.right, b.left - a.right, 0), Math.max(a.top - b.bottom, b.top - a.bottom, 0));
  let smallestPairGap = Infinity;
  for (let state = 0; state < 256; state++) {
    const colors = EXPECTED.map((_, index) => state & (1 << index) ? 6 : 1);
    const tones = EXPECTED.map((_, index) => state & (1 << (index + 4)) ? 6 : 1);
    const markup = renderVariableArrows(chartFor(tones, colors));
    const bounds = arrows(markup).flatMap((arrow, index) => [glyphBounds(arrow.color, EXPECTED[index]), glyphBounds(arrow.tone, EXPECTED[index])]);
    assert.equal(bounds.length, 8, 'every Color and Tone glyph is included');
    for (let index = 0; index < bounds.length; index++) {
      for (let other = index + 1; other < bounds.length; other++) smallestPairGap = Math.min(smallestPairGap, gap(bounds[index], bounds[other]));
    }
  }
  assert.ok(Math.abs(smallestPairGap - 15.775 * BLOCK_SCALE) < 1e-9, 'the common scale also enlarges the original 15.775-unit minimum gap');
});

test('Color and Tone retain approved local positions and spacing inside the enlarged common block', () => {
  const rendered = arrows(renderVariableArrows(chartFor()));
  for (const source of ['design', 'personality'] as const) {
    const positions = rendered.filter((arrow: { attrs: { [x: string]: string; }; }) => arrow.attrs['data-source'] === source).map((arrow) => {
      const match = arrow.attrs.transform.match(/^translate\(([\d.]+) ([\d.]+)\)$/);
      assert.ok(match);
      return { x: Number(match![1]), y: Number(match![2]) };
    });
    assert.equal(positions.length, 2);
    assert.deepEqual(positions.map(point => point.y), [134, 206], 'approved horizontal rows do not move');
    assert.ok(positions.every((point: { x: number; }) => point.x === (source === 'design' ? 148 : 492)));
    assert.equal(positions[0].x - (source === 'design' ? 164 : 476), source === 'design' ? -16 : 16);
    assert.equal((positions[0].y + positions[1].y) / 2, 170, 'the vertical block midpoint does not move');
    const separation = positions[1].y - positions[0].y;
    assert.equal(separation, 72);
    const reduction = 1 - separation / 84;
    assert.ok(reduction >= 0.10 && reduction <= 0.15, 'the rows are 10–15% closer');
    const pair = rendered.find((arrow: { attrs: { [x: string]: string; }; }) => arrow.attrs['data-source'] === source);
    const glyphXs = [pair!.color, pair!.tone].map(glyph => positions[0].x + glyph.shift);
    assert.equal(glyphXs[1] - glyphXs[0], 72);
    assert.ok(Math.abs(1 - (glyphXs[1] - glyphXs[0]) / 80 - 0.1) < 1e-12, 'horizontal spacing is 10% closer');
    const previousXs = source === 'design' ? [124, 204] : [436, 516];
    assert.deepEqual(glyphXs.map((x, index) => x - previousXs[index]), source === 'design' ? [-12, -20] : [20, 12], 'inner columns move farther outward; neither outer column moves back toward the head');
  }
});

test('all eight arrows clear the numbers, planets and compact activation hit areas in both columns', () => {
  const complete = chartFor();
  for (const source of ['design', 'personality'] as const) {
    const prototype = complete.activations[source][0];
    for (const [planet] of PLANETS) if (!complete.activations[source].some((entry: { planet: string; }) => entry.planet === planet)) {
      complete.activations[source].push({ ...prototype, planet });
    }
  }
  const targets = parseSvg(renderActivationColumns(complete)).children.flatMap(column => {
    const source = column.attrs['data-source'], columnSide = column.attrs['data-column-side'];
    const rows = columnContent(column!).children.filter(node => hasClass(node, 'activation-row'));
    assert.equal(rows.length, 13, 'both complete calculation columns are included');
    return rows.flatMap(row => {
      const translated = row.attrs.transform.match(/^translate\((-?[\d.]+) (-?[\d.]+)\)$/);
      assert.ok(translated);
      const x = Number(translated[1]), y = Number(translated[2]);
      assert.equal(x, columnSide === 'left' ? -48 : 600, 'only calculation columns shift sixteen units outward');
      const controls = row.children.filter((node: { attrs: { [x: string]: string; }; }) => ['planet', 'gate'].includes(node.attrs['data-type']));
      assert.equal(controls.length, 2);
      return controls.map(control => {
        const rectangles = control.children.filter((node: { name: string; }) => node.name === 'rect');
        assert.equal(rectangles.length, 1);
        const rect = rectangles[0].attrs, planet = control.attrs['data-type'] === 'planet';
        assert.deepEqual([Number(rect.x), Number(rect.y), Number(rect.width), Number(rect.height)], planet ? [-8, -24, 32, 48] : [24, -24, 72, 48], 'both targets meet without a gap and fill the complete compact row');
        return blockBounds({ source, left: x + Number(rect.x), right: x + Number(rect.x) + Number(rect.width), top: y + Number(rect.y), bottom: y + Number(rect.y) + Number(rect.height) }, columnSide);
      });
    });
  });
  assert.equal(targets.length, 52, '26 planets and 26 numeric hit areas are checked');
  const gap = (a: { left: number; right: number; top: number; bottom: number; }, b: { right: number; left: number; bottom: number; top: number; }) => Math.hypot(Math.max(a.left - b.right, b.left - a.right, 0), Math.max(a.top - b.bottom, b.top - a.bottom, 0));
  const minimum: Record<string, number> = { design: Infinity, personality: Infinity };
  for (const color of [1, 6] as const) for (const tone of [1, 6] as const) {
    const rendered = arrows(renderVariableArrows(chartFor([tone, tone, tone, tone], [color, color, color, color])));
    rendered.forEach((arrow, index) => {
      for (const glyph of [arrow.color, arrow.tone] as const) {
        const bounds = glyphBounds(glyph, EXPECTED[index]);
        for (const target of targets) {
          const distance = gap(bounds, target);
          assert.ok(distance > 0, 'scaled arrow and stroke stay outside every calculation hit rectangle');
          if (target.source === arrow.attrs['data-source']) minimum[target.source] = Math.min(minimum[target.source], distance);
        }
      }
    });
  }
  assert.ok(Math.abs(minimum.design - 37.1875 * BLOCK_SCALE) < 1e-9, 'the whole left block keeps its arrows fixed while the calculation targets move outward');
  assert.ok(Math.abs(minimum.personality - 35.8875 * BLOCK_SCALE) < 1e-9, 'the whole right block keeps its arrows fixed while the calculation targets move outward');
});

test('the decorative Variable layer passes pointer input through and introduces no gesture or keyboard targets', () => {
  const markup = renderVariableArrows(chartFor());
  assert.equal(arrows(markup).length, 4);
  for (const [tag] of markup.matchAll(/<[a-z][^>]*>/g)) {
    const attrs = attributes(tag);
    assert.equal(attrs['data-type'], undefined);
    assert.equal(attrs.tabindex, undefined);
    assert.notEqual(attrs.role, 'button');
    assert.equal(attrs['aria-pressed'], undefined);
    assert.ok(!Object.keys(attrs).some(name => /^on/i.test(name)), 'no inline event handlers');
    if (attrs['pointer-events'] !== undefined) assert.equal(attrs['pointer-events'], 'none', 'descendants cannot restore pointer hit testing');
    const pointerStyle = attrs.style?.match(/pointer-events\s*:\s*([^;]+)/)?.[1].trim();
    if (pointerStyle !== undefined) assert.equal(pointerStyle, 'none', 'inline styles cannot override pointer pass-through');
  }
});

test('adding Color/Tone data changes only its decorative layer and preserves full graph geometry and interactions', () => {
  const geometry = JSON.stringify({ CENTERS, GATES, CHANNELS });
  const modes: RenderOptions[] = [
    {}, { selections: [{ type: 'gate' as const, id: 41 }] },
    { selections: [{ type: 'center' as const, id: 'root' }, { type: 'channel' as const, id: '20-57' }], previewSelection: { type: 'gate' as const, id: 10 } },
    { selections: [{ type: 'planet' as const, id: 'design-sun' }], interactive: false, idPrefix: 'variables-thumbnail' },
  ];
  const freeze = <T>(value: T): T => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
  for (let state = 0; state < 16; state++) {
    const tones = EXPECTED.map((_, index) => state & (1 << index) ? 6 : 1);
    const colors = EXPECTED.map((_, index) => (state + index) % 6 + 1);
    const chart = freeze(chartFor(tones, colors)), withoutVariables = { ...chart, source: undefined };
    const before = JSON.stringify(chart), layer = renderVariableArrows(chart);
    assert.ok(layer);
    for (const mode of modes) {
      const options = { ...mode, showActivations: true };
      const actual = renderBodygraph(chart, null, options), expected = renderBodygraph(withoutVariables, null, options);
      assert.equal(actual.split(layer).length, 2, 'the full drawing includes the complete Variable group exactly once');
      assert.equal(actual.replace(layer, ''), expected, 'removing only the Variable group preserves every remaining SVG byte');
      for (const showActivations of [undefined, false] as const) {
        const hiddenOptions = { ...mode, showActivations };
        assert.equal(renderBodygraph(chart, null, hiddenOptions), renderBodygraph(withoutVariables, null, hiddenOptions), 'hidden activations also omit Variable glyphs without any other SVG change');
      }
    }
    assert.equal(JSON.stringify(chart), before, 'rendering does not mutate saved data');
  }
  assert.equal(JSON.stringify({ CENTERS, GATES, CHANNELS }), geometry, 'shared geometry remains unchanged');
});
