import { CENTERS, GATES, CHANNELS, getGate, getChannel, getDefinition } from './graph-data.js';

const PALETTE = {
  ink: '#202020', design: '#c32d35', outline: '#c6c2b9', paper: '#ffffff',
  accent: '#3b72b8', halo: '#c4d9f1',
  // Traditional center families, with flat colors rather than decorative fills.
  // Reference: jovianarchive.com/blogs/human-design-basics/the-9-centers-in-human-design
  head: '#edcd4c', ajna: '#79a367', throat: '#b58a60', g: '#edcd4c',
  heart: '#da514b', spleen: '#b58a60', solar: '#b58a60', sacral: '#da514b', root: '#b58a60',
};

const escape = (value) => String(value).replace(/[&<>"']/g, (character) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[character]));

const pointString = (points) => points.map(([x, y], index) => `${index ? 'L' : 'M'}${x.toFixed(2)},${y.toFixed(2)}`).join(' ');

function sampleCurve(curve) {
  return Array.from({ length: 49 }, (_, index) => {
    const t = index / 48, u = 1 - t;
    return [0, 1].map((axis) => u ** 3 * curve[0][axis] + 3 * u * u * t * curve[1][axis]
      + 3 * u * t * t * curve[2][axis] + t ** 3 * curve[3][axis]);
  });
}

function splitAtHalfLength(points) {
  const lengths = points.slice(1).map((point, index) => Math.hypot(point[0] - points[index][0], point[1] - points[index][1]));
  const midpoint = lengths.reduce((sum, length) => sum + length, 0) / 2;
  let distance = 0;
  for (let index = 0; index < lengths.length; index += 1) {
    if (distance + lengths[index] >= midpoint) {
      const fraction = lengths[index] ? (midpoint - distance) / lengths[index] : 0;
      const middle = points[index].map((value, axis) => value + (points[index + 1][axis] - value) * fraction);
      return [[...points.slice(0, index + 1), middle], [middle, ...points.slice(index + 1)]];
    }
    distance += lengths[index];
  }
  return [points, points.slice(-1)];
}

function offsetPoints(points, offset) {
  return points.map(([x, y], index) => {
    const before = points[Math.max(0, index - 1)], after = points[Math.min(points.length - 1, index + 1)];
    const dx = after[0] - before[0], dy = after[1] - before[1];
    const length = Math.hypot(dx, dy) || 1;
    return [x - dy / length * offset, y + dx / length * offset];
  });
}

// Geometry is cached; selection changes do not resample 36 curves.
const channelHalves = new Map(CHANNELS.map((channel) => [channel.id, splitAtHalfLength(sampleCurve(channel.curve))]));

// Integration is a shared anatomical stem with two spaced branch attachments.
// There is no central dot, radial menu, or additional Center.
const INTEGRATION_IDS = new Set(['10-20', '20-34', '20-57', '10-34', '10-57', '34-57']);
const STEM_TOP = [214, 455], STEM_BOTTOM = [214, 529];
const INTEGRATION_ARMS = [
  { gate: 20, end: STEM_TOP, controls: [[226, 386], [214, 415]] },
  { gate: 10, end: STEM_TOP, controls: [[249, 486], [234, 462]] },
  { gate: 34, end: STEM_BOTTOM, controls: [[231, 613], [214, 574]] },
  { gate: 57, end: STEM_BOTTOM, controls: [[163, 548], [187, 534]] },
].map(({ gate, controls, end }) => {
  const { x, y } = getGate(gate);
  const curve = [[x, y], ...controls, end];
  return { gate, end, points: sampleCurve(curve), path: `M ${x} ${y} C ${controls.flat().join(' ')} ${end.join(' ')}` };
});
const STEM_POINTS = [STEM_TOP, STEM_BOTTOM];
const STEM_PATH = pointString(STEM_POINTS);
const INTEGRATION_PATH = [...INTEGRATION_ARMS.map(({ path }) => path), STEM_PATH].join(' ');

function integrationRoute(gates) {
  const first = INTEGRATION_ARMS.find(({ gate }) => gate === gates[0]);
  const second = INTEGRATION_ARMS.find(({ gate }) => gate === gates[1]);
  const points = [...first.points];
  if (first.end !== second.end) points.push(second.end);
  points.push(...[...second.points].reverse().slice(1));
  return pointString(points);
}

/**
 * SVG inner markup, for a parent SVG with viewBox="0 0 640 820".
 * chart.personality/design: gate-number arrays. No birth-date calculation occurs.
 * selection: null | {type: 'gate' | 'center' | 'channel' | 'integration', id}.
 * options: { interactive?: boolean, idPrefix?: string, showLabels?: boolean, dimInactive?: boolean }.
 * The parent owns gestures, event delegation, and persisted view transforms.
 */
export function renderBodygraph(chart = {}, selection = null, options = {}) {
  const personality = new Set((chart.personality || []).map(Number));
  const design = new Set((chart.design || []).map(Number));
  const definition = getDefinition(chart);
  const definedChannels = new Set(definition.channels.map(({ id }) => id));
  const interactive = options.interactive !== false;
  const prefix = String(options.idPrefix || 'bodygraph').replace(/[^a-zA-Z0-9_-]/g, '') || 'bodygraph';
  const relatedChannels = new Set();
  const relatedGates = new Set();
  const selectedChannel = selection?.type === 'channel' ? getChannel(selection.id) : null;

  CHANNELS.forEach((channel) => {
    const related = (selection?.type === 'gate' && channel.gates.includes(Number(selection.id)))
      || (selection?.type === 'center' && channel.gates.some((id) => getGate(id).center === selection.id))
      || channel.id === selectedChannel?.id;
    if (related) {
      relatedChannels.add(channel.id);
      channel.gates.forEach((id) => relatedGates.add(id));
    }
  });

  const attrs = (type, id, label, pressed) => `data-type="${type}" data-id="${escape(id)}"`
    + (interactive ? ` class="bg-interactive" tabindex="0" role="button" aria-label="${escape(label)}" aria-pressed="${Boolean(pressed)}"` : '');
  const stroke = (points, color, width, offset = 0) => `<path d="${pointString(offset ? offsetPoints(points, offset) : points)}" fill="none" stroke="${color}" stroke-width="${width}" stroke-linecap="butt" stroke-linejoin="round" pointer-events="none"/>`;

  const channels = CHANNELS.map((channel) => {
    if (INTEGRATION_IDS.has(channel.id)) return '';
    const related = relatedChannels.has(channel.id);
    const hasActiveHalf = channel.gates.some((id) => personality.has(id) || design.has(id));
    const opacity = options.dimInactive && !hasActiveHalf && !related ? 0.2 : 1;
    const halves = channelHalves.get(channel.id).map((points, index) => {
      const id = channel.gates[index], black = personality.has(id), red = design.has(id);
      if (black && red) {
        // Parallel lanes preserve both sources rather than letting one hide the other.
        return stroke(points, PALETTE.ink, 2.3, -1.2) + stroke(points, PALETTE.design, 2.3, 1.2);
      }
      return black || red ? stroke(points, black ? PALETTE.ink : PALETTE.design, 4.6) : '';
    }).join('');
    return `<g ${attrs('channel', channel.id, `Канал ${channel.id}: ${channel.name}`, channel.id === selectedChannel?.id)} data-defined="${definedChannels.has(channel.id)}" data-related="${related}" opacity="${opacity}">
      ${related ? `<path d="${channel.path}" fill="none" stroke="${PALETTE.halo}" stroke-width="10" stroke-linecap="round" pointer-events="none"/>` : ''}
      <path class="bg-channel-outline" d="${channel.path}" fill="none" stroke="${PALETTE.outline}" stroke-width="6.4" stroke-linecap="round" pointer-events="none"/>
      <path d="${channel.path}" fill="none" stroke="${PALETTE.paper}" stroke-width="4.6" stroke-linecap="round" pointer-events="none"/>
      ${halves}
      <path class="bg-focus-shape" d="${channel.path}" fill="none" stroke="transparent" stroke-width="19" stroke-linecap="round" pointer-events="${interactive ? 'stroke' : 'none'}"/>
    </g>`;
  }).join('');

  const integrationChannels = CHANNELS.filter((channel) => INTEGRATION_IDS.has(channel.id));
  const integrationSelected = selection?.type === 'integration';
  const selectedIntegrationChannel = selectedChannel && INTEGRATION_IDS.has(selectedChannel.id) ? selectedChannel : null;
  const highlightedArms = new Set(integrationSelected ? [20, 10, 34, 57]
    : selectedIntegrationChannel ? selectedIntegrationChannel.gates
      : selection?.type === 'gate' ? [Number(selection.id)]
        : selection?.type === 'center' ? INTEGRATION_ARMS.filter(({ gate }) => getGate(gate).center === selection.id).map(({ gate }) => gate) : []);
  const integrationArmState = INTEGRATION_ARMS.map((arm) => {
    const { gate } = arm;
    const black = personality.has(gate), red = design.has(gate);
    const highlighted = highlightedArms.has(gate);
    const opacity = options.dimInactive && !black && !red && !highlighted ? 0.2 : 1;
    return { ...arm, black, red, highlighted, opacity };
  });
  const active = (gate) => personality.has(gate) || design.has(gate);
  const crossesStem = [20, 10].some(active) && [34, 57].some(active);
  const stemHighlighted = integrationSelected || (selectedIntegrationChannel && [20, 10].includes(selectedIntegrationChannel.gates[0]) !== [20, 10].includes(selectedIntegrationChannel.gates[1]));
  const stemOpacity = options.dimInactive && !crossesStem && !stemHighlighted ? 0.2 : 1;
  const backgroundParts = [...integrationArmState, { path: STEM_PATH, opacity: stemOpacity }];
  const integrationBackground = backgroundParts.map(({ path, opacity }) => `<path d="${path}" fill="none" stroke="${PALETTE.outline}" stroke-width="6.4" stroke-linecap="round" opacity="${opacity}" pointer-events="none"/>`).join('')
    + backgroundParts.map(({ path, opacity }) => `<path d="${path}" fill="none" stroke="${PALETTE.paper}" stroke-width="4.6" stroke-linecap="round" opacity="${opacity}" pointer-events="none"/>`).join('');
  const paintActivation = (points, black, red) => black && red
    ? stroke(points, PALETTE.ink, 2.3, -1.2) + stroke(points, PALETTE.design, 2.3, 1.2)
    : black || red ? stroke(points, black ? PALETTE.ink : PALETTE.design, 4.6) : '';
  const integrationBranches = integrationArmState.map(({ gate, points, black, red, highlighted, opacity }) => {
    return `<g class="bg-integration-arm" data-arm="${gate}" data-related="${highlighted}" opacity="${opacity}" pointer-events="none">
      ${paintActivation(points, black, red)}
    </g>`;
  }).join('');
  const stemHalves = splitAtHalfLength(STEM_POINTS);
  const integrationStem = crossesStem ? stemHalves.map((points, index) => {
    const gates = index ? [34, 57] : [20, 10];
    return paintActivation(points, gates.some((gate) => personality.has(gate)), gates.some((gate) => design.has(gate)));
  }).join('') : '';
  const selectionPath = integrationSelected ? INTEGRATION_PATH
    : selectedIntegrationChannel ? integrationRoute(selectedIntegrationChannel.gates)
      : INTEGRATION_ARMS.filter(({ gate }) => highlightedArms.has(gate)).map(({ path }) => path).join(' ');
  // The six channel buttons are siblings of the bundle, keyboard-only in the
  // graph. Pointer input belongs to the one complete integration bundle.
  const integrationSelectors = integrationChannels.map((channel) => {
    const selected = channel.id === selectedChannel?.id;
    const related = relatedChannels.has(channel.id);
    const hasActiveHalf = channel.gates.some((id) => personality.has(id) || design.has(id));
    const opacity = options.dimInactive && !hasActiveHalf && !related ? 0.2 : 1;
    return `<g ${attrs('channel', channel.id, `Канал ${channel.id}: ${channel.name}`, selected)} data-integration="true" data-defined="${definedChannels.has(channel.id)}" data-related="${related}" opacity="${opacity}">
      <path class="bg-integration-focus" d="${integrationRoute(channel.gates)}" fill="none" stroke="${PALETTE.accent}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" opacity="0" pointer-events="none"/>
    </g>`;
  }).join('');

  const integration = `<g ${attrs('integration', 'integration', 'Интеграция: ворота 20, 10, 57 и 34, шесть каналов', integrationSelected)} data-junction="integration">
    ${integrationBackground}
    ${integrationBranches}
    ${integrationStem}
    ${selectionPath ? `<path d="${selectionPath}" fill="none" stroke="${PALETTE.accent}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" pointer-events="none"/>` : ''}
    <path class="bg-integration-focus" d="${INTEGRATION_PATH}" fill="none" stroke="${PALETTE.accent}" stroke-width="2.5" stroke-linecap="round" opacity="0" pointer-events="none"/>
    <path d="${INTEGRATION_PATH}" fill="none" stroke="transparent" stroke-width="20" stroke-linecap="round" pointer-events="${interactive ? 'stroke' : 'none'}"/>
  </g>${integrationSelectors}`;

  const centers = CENTERS.map((center) => {
    const selected = selection?.type === 'center' && selection.id === center.id;
    const defined = definition.centers.has(center.id);
    const opacity = options.dimInactive && !defined && !selected ? 0.45 : 1;
    let labels = [center.name];
    if (center.id === 'solar') labels = ['Солнечное', 'сплетение'];
    if (center.id === 'spleen') labels = ['Селезёночный'];
    return `<g ${attrs('center', center.id, `${center.name} центр, ${defined ? 'определён' : 'не определён'}`, selected)} data-defined="${defined}" opacity="${opacity}">
      ${selected ? `<polygon points="${center.points}" fill="none" stroke="${PALETTE.halo}" stroke-width="12" stroke-linejoin="round" pointer-events="none"/>` : ''}
      <polygon class="bg-center-shape" points="${center.points}" fill="${defined ? PALETTE[center.id] : PALETTE.paper}" stroke="${selected ? PALETTE.accent : defined ? '#84715b' : '#b4b0a7'}" stroke-width="${selected ? '2.5' : '1.25'}" stroke-linejoin="round"/>
      ${options.showLabels === true ? `<text x="${center.labelX}" y="${center.labelY}" text-anchor="middle" font-family="Inter, -apple-system, BlinkMacSystemFont, sans-serif" font-size="${['spleen', 'solar'].includes(center.id) ? 7.5 : 8.5}" font-weight="500" letter-spacing=".1" fill="#171513" pointer-events="none">${labels.map((label, index) => `<tspan x="${center.labelX}" dy="${index ? 9 : 0}">${escape(label)}</tspan>`).join('')}</text>` : ''}
    </g>`;
  }).join('');

  const gates = GATES.map((gate) => {
    const black = personality.has(gate.id), red = design.has(gate.id);
    const active = black || red;
    const selected = selection?.type === 'gate' && Number(selection.id) === gate.id;
    const related = relatedGates.has(gate.id);
    const opacity = options.dimInactive && !active && !selected && !related ? 0.3 : 1;
    const fill = black && red ? `url(#${prefix}-dual)` : black ? PALETTE.ink : red ? PALETTE.design : PALETTE.paper;
    const source = black && red ? 'личность и дизайн' : black ? 'личность' : red ? 'дизайн' : 'не активированы';
    return `<g ${attrs('gate', gate.id, `Ворота ${gate.id}: ${gate.name}, ${source}`, selected)} data-active="${active}" data-related="${related}" opacity="${opacity}" transform="translate(${gate.x} ${gate.y})">
      <circle r="12.5" fill="transparent" pointer-events="${interactive ? 'all' : 'none'}"/>
      ${selected || related ? `<circle r="${selected ? 14 : 11.7}" fill="${PALETTE.halo}" stroke="${selected ? PALETTE.accent : PALETTE.halo}" stroke-width="${selected ? 1.7 : 1}" pointer-events="none"/>` : ''}
      <circle class="bg-gate-disc" r="9.5" fill="${active ? fill : 'transparent'}" stroke="${active ? fill.startsWith('url') ? PALETTE.ink : fill : 'none'}" stroke-width=".8" pointer-events="none"/>
      <text y=".5" text-anchor="middle" dominant-baseline="central" font-family="Inter, -apple-system, BlinkMacSystemFont, sans-serif" font-size="11" font-weight="${active ? '650' : '500'}" fill="${active ? '#ffffff' : '#171513'}" pointer-events="none">${gate.id}</text>
    </g>`;
  }).join('');

  return `<defs>
    <linearGradient id="${prefix}-dual" x1="0%" y1="0%" x2="100%" y2="0%"><stop offset="50%" stop-color="${PALETTE.ink}"/><stop offset="50%" stop-color="${PALETTE.design}"/></linearGradient>
  </defs>
  <style>
    .bg-interactive { cursor: pointer; outline: none; }
    .bg-interactive:focus-visible .bg-gate-disc, .bg-interactive:focus-visible .bg-center-shape { stroke: #3b72b8; stroke-width: 3; }
    .bg-interactive:focus-visible .bg-channel-outline { stroke: #3b72b8; stroke-width: 9; }
    .bg-interactive:focus-visible > .bg-integration-focus { opacity: 1; }
    @media (hover: hover) { .bg-interactive:hover .bg-gate-disc, .bg-interactive:hover .bg-center-shape { stroke: #3b72b8; stroke-width: 2; } }
  </style>
  <g class="bodygraph-drawing" ${interactive ? '' : 'pointer-events="none"'}>
    <g class="bodygraph-channels">${channels}${integration}</g>
    <g class="bodygraph-centers">${centers}</g>
    <g class="bodygraph-gates">${gates}</g>
  </g>`;
}
