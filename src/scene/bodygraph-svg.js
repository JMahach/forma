import { PALETTE, CHANNEL_WIDTH, stroke, paintActivation, integrationPaint, integrationOutlineMask, integrationChannels, stemHalves, armPaintPoints } from './bodygraph-paint.js';
import { CENTERS, GATES, getChannel } from './geometry/chart-geometry.js';
import { renderActivationColumns } from './activation-columns.js';
import { renderVariableArrows } from './variable-arrows.js';
import { renderMandala } from './mandala.js';
import { MANDALA_SCENE_SCALE } from './geometry/mandala-geometry.js';
import { renderMandalaUnderlay } from './mandala-underlay.js';
import { renderChartBackdrop } from './backdrop.js';
import { INTEGRATION_IDS } from '../domain/topology.js';
import {
  roundedCenter, channelHalves, paintOrder,
  INTEGRATION_ARMS, STEM_PATH, INTEGRATION_PATH, INTEGRATION_INNER_SIDE,
  INTEGRATION_OUTER_SIDE, integrationOuterOwnership, integrationEndPlanes, integrationRoute,
} from './geometry/drawing-geometry.js';
import { createRenderState } from './render-state.js';

const escape = (value) => String(value).replace(/[&<>"']/g, (character) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[character]));

/**
 * SVG inner markup, for a parent SVG with viewBox="0 0 640 820".
 * chart.personality/design: gate-number arrays. No birth-date calculation occurs.
 * selection: null | {type: 'gate' | 'center' | 'channel' | 'integration', id}.
 * options: { profile?: 'thumbnail', interactive?: boolean, idPrefix?: string, showLabels?: boolean, dimInactive?: boolean, showLotus?: boolean,
 *   showActivations?: boolean, selections?: Array<typeof selection>, previewSelection?: typeof selection,
 *   activationFilter?: { line: number, source: 'design' | 'personality' | 'all' }
 *     | { groups: Array<{ line: number, source: 'design' | 'personality' | 'all', gates?: number[] }>, unfilteredGates: number[] } }.
 * Preview paint is added to the pinned selection without changing pressed state.
 * The parent owns gestures, event delegation, and persisted view transforms.
 */
export function renderBodygraph(chart = {}, selection = null, options = {}) {
  const thumbnail = options.profile === 'thumbnail';
  if (thumbnail) {
    // A library image is an unselected physical chart. Keep this one explicit
    // profile separate from interactive:false: static stories can show choices.
    selection = null;
    options = { profile: 'thumbnail', idPrefix: options.idPrefix, interactive: false,
      showActivations: false, showLabels: false, showBackdrop: true };
  }
  const {
    committedSelection, committedSelections, visualSelections,
    personality, design, definition, definedChannels, interactive, prefix,
    relatedChannels, relatedGates, halfGates, selectedGates, selectedCenters,
    selectedChannels, committedGates, previewGates,
  } = createRenderState(chart, selection, options);
  const attrs = (type, id, label, pressed) => {
    if (options.previewSelection || options.selections) pressed = committedSelections.some(value => type === value.type
      && String(id) === String(type === 'channel' ? getChannel(value.id)?.id : value.id));
    return `data-type="${type}" data-id="${escape(id)}"`
      + (interactive ? ` class="bg-interactive" tabindex="0" role="button" aria-label="${escape(label)}" aria-pressed="${Boolean(pressed)}"` : '');
  };
  const channels = paintOrder.map((channel) => {
    if (INTEGRATION_IDS.has(channel.id)) return '';
    const related = relatedChannels.has(channel.id);
    const hasActiveHalf = channel.gates.some((id) => personality.has(id) || design.has(id));
    const opacity = options.dimInactive && !hasActiveHalf && !related ? 0.2 : 1;
    const highlight = !thumbnail && !selectedChannels.has(channel.id)
      ? channelHalves.get(channel.id).map((points, index) => halfGates.has(channel.gates[index])
        ? `<g data-highlight-gate="${channel.gates[index]}">${stroke(points, PALETTE.halo, CHANNEL_WIDTH.halo)}</g>` : '').join('')
      : '';
    const halves = channelHalves.get(channel.id).map((points, index) => {
      const id = channel.gates[index];
      return paintActivation(points, personality.has(id), design.has(id));
    }).join('');
    return `<g ${attrs('channel', channel.id, `Канал ${channel.id}: ${channel.name}`, selectedChannels.has(channel.id))} data-defined="${definedChannels.has(channel.id)}" data-related="${related}" opacity="${opacity}">
      ${highlight}
      ${thumbnail ? '' : `<path class="bg-channel-highlight" d="${channel.path}" fill="none" stroke="${PALETTE.halo}" stroke-width="${CHANNEL_WIDTH.halo}" stroke-linecap="round" opacity="${selectedChannels.has(channel.id) ? 1 : 0}" pointer-events="none"/>`}
      <path class="bg-channel-outline" d="${channel.path}" fill="none" stroke="${PALETTE.outline}" stroke-width="${CHANNEL_WIDTH.outline}" stroke-linecap="round" pointer-events="none"/>
      <path d="${channel.path}" fill="none" stroke="${PALETTE.paper}" stroke-width="${CHANNEL_WIDTH.paint}" stroke-linecap="round" pointer-events="none"/>
      ${halves}
      ${thumbnail ? '' : `<path class="bg-focus-shape" d="${channel.path}" fill="none" stroke="transparent" stroke-width="19" stroke-linecap="round" pointer-events="${interactive ? 'stroke' : 'none'}"/>`}
    </g>`;
  }).join('');

  const { integrationSelected, highlightedArms, integrationArmState, crossesStem, stemHighlighted,
    connectedIntegrationGates, activeIntegrationParts, stemOpacity, selectionPath, integrationFocusOpacity } = integrationPaint({
      visualSelections, selectedChannels, halfGates, personality, design, relatedChannels,
    }, options);
  const backgroundParts = [...integrationArmState, { path: STEM_PATH, opacity: stemOpacity }];
  const integrationBackground = backgroundParts.map(({ path, opacity }) => `<path d="${path}" fill="none" stroke="${PALETTE.outline}" stroke-width="${CHANNEL_WIDTH.outline}" stroke-linecap="round" stroke-linejoin="round" opacity="${opacity}" pointer-events="none"/>`).join('')
    + backgroundParts.map(({ path, opacity }) => `<path d="${path}" fill="none" stroke="${PALETTE.paper}" stroke-width="${CHANNEL_WIDTH.paint}" stroke-linecap="round" stroke-linejoin="round" opacity="${opacity}" pointer-events="none"/>`).join('');
  const integrationBranches = integrationArmState.map(({ gate, points, reversePaint, black, red, highlighted, opacity }) => {
    return `<g class="bg-integration-arm" data-arm="${gate}" data-related="${highlighted}" opacity="${opacity}" pointer-events="none">
      ${paintActivation(armPaintPoints.get(gate), black, red)}
    </g>`;
  }).join('');
  const integrationStem = crossesStem ? stemHalves.map((points, index) => {
    const gates = index ? [34, 57] : [20, 10];
    return paintActivation(points, gates.some((gate) => personality.has(gate)), gates.some((gate) => design.has(gate)));
  }).join('') : '';
  // Integration halos sit above ordinary crossings (including 26–44), but
  // below the integration's own physical arms, whether white, black or red.
  const integrationHighlights = thumbnail ? '' : `<g class="bodygraph-integration-highlights" pointer-events="none">
    <path class="bg-integration-hover" d="${INTEGRATION_PATH}" fill="none" stroke="${PALETTE.halo}" stroke-width="${CHANNEL_WIDTH.halo}" stroke-linecap="butt" stroke-linejoin="round" mask="url(#${prefix}-integration-outline)" opacity="0" pointer-events="none"/>
    ${selectionPath ? `<path class="bg-integration-selection" d="${selectionPath}" fill="none" stroke="${PALETTE.halo}" stroke-width="${CHANNEL_WIDTH.halo}" stroke-linecap="${integrationSelected ? 'butt' : 'round'}" stroke-linejoin="round" mask="url(#${prefix}-${integrationSelected ? 'integration-outline' : 'integration-selection-outline'})" pointer-events="none"/>` : ''}
    ${integrationChannels.map(channel => `<path class="bg-integration-focus" data-highlight-channel="${channel.id}" d="${integrationRoute(channel.gates)}" fill="none" stroke="${PALETTE.halo}" stroke-width="${CHANNEL_WIDTH.halo}" stroke-linecap="round" stroke-linejoin="round" mask="url(#${prefix}-integration-focus-${channel.id})" opacity="0" style="--integration-focus-opacity:${integrationFocusOpacity(channel)}" pointer-events="none"/>`).join('')}
  </g>`;
  // The six channel buttons are siblings of the bundle, keyboard-only in the
  // graph. Transparent paths preserve their focus bounds; their halos live in
  // the lower layer. Pointer input belongs to the complete integration bundle.
  const integrationSelectors = thumbnail ? '' : integrationChannels.map((channel) => {
    const selected = selectedChannels.has(channel.id);
    const related = relatedChannels.has(channel.id);
    const opacity = integrationFocusOpacity(channel);
    return `<g ${attrs('channel', channel.id, `Канал ${channel.id}: ${channel.name}`, selected)} data-integration="true" data-defined="${definedChannels.has(channel.id)}" data-related="${related}" opacity="${opacity}">
      <path class="bg-integration-focus-target" d="${integrationRoute(channel.gates)}" fill="none" stroke="transparent" stroke-width="${CHANNEL_WIDTH.halo}" stroke-linecap="round" stroke-linejoin="round" pointer-events="none"/>
    </g>`;
  }).join('');

  const integration = `<g ${attrs('integration', 'integration', 'Интеграция: ворота 20, 10, 57 и 34, шесть каналов', integrationSelected)} data-junction="integration" data-visual-selected="${integrationSelected}">
    ${integrationBackground}
    ${integrationBranches}
    ${integrationStem}
    ${thumbnail ? '' : `<path d="${INTEGRATION_PATH}" fill="none" stroke="transparent" stroke-width="20" stroke-linecap="round" pointer-events="${interactive ? 'stroke' : 'none'}"/>`}
  </g>${integrationSelectors}`;

  const centers = CENTERS.map((center) => {
    const shape = roundedCenter(center.points);
    // Completing a center's individual gates adds its outline, not another
    // pinned item: removing any gate naturally removes the inferred outline.
    const selected = selectedCenters.has(center.id)
      || GATES.filter(gate => gate.center === center.id).every(gate => selectedGates.has(gate.id));
    const defined = definition.centers.has(center.id);
    const opacity = options.dimInactive && !defined && !selected ? 0.45 : 1;
    let labels = [center.name];
    if (center.id === 'solar') labels = ['Солнечное', 'сплетение'];
    if (center.id === 'spleen') labels = ['Селезёночный'];
    return `<g ${attrs('center', center.id, `${center.name} центр, ${defined ? 'определён' : 'не определён'}`, selected)} data-defined="${defined}" opacity="${opacity}">
      <path class="bg-center-shape" data-center-points="${center.points}" d="${shape}" fill="${defined ? PALETTE[center.id] : PALETTE.paper}" stroke="${defined ? '#84715b' : '#b4b0a7'}" stroke-width="1.25" stroke-linejoin="round"/>
      ${thumbnail ? '' : `<path class="bg-center-highlight" d="${shape}" fill="none" stroke="${PALETTE.halo}" stroke-width="2.5" stroke-linejoin="round" opacity="${selected ? 1 : 0}" pointer-events="none"/>`}
      ${options.showLabels === true ? `<text x="${center.labelX}" y="${center.labelY}" text-anchor="middle" font-family="Inter, -apple-system, BlinkMacSystemFont, sans-serif" font-size="${['spleen', 'solar'].includes(center.id) ? 7.5 : 8.5}" font-weight="500" letter-spacing=".1" fill="#171513" pointer-events="none">${labels.map((label, index) => `<tspan x="${center.labelX}" dy="${index ? 9 : 0}">${escape(label)}</tspan>`).join('')}</text>` : ''}
    </g>`;
  }).join('');

  const gates = thumbnail ? '' : GATES.map((gate) => {
    const black = personality.has(gate.id), red = design.has(gate.id);
    const active = black || red;
    const selected = selectedGates.has(gate.id);
    const related = relatedGates.has(gate.id);
    const opacity = options.dimInactive && !active && !selected && !related ? 0.3 : 1;
    const fill = black && red ? `url(#${prefix}-dual)` : black ? PALETTE.ink : red ? PALETTE.design : PALETTE.paper;
    const source = black && red ? 'личность и дизайн' : black ? 'личность' : red ? 'дизайн' : 'не активированы';
    return `<g ${attrs('gate', gate.id, `Ворота ${gate.id}: ${gate.name}, ${source}`, selected)} data-active="${active}" data-related="${related}" opacity="${opacity}" transform="translate(${gate.x} ${gate.y})">
      <circle r="12.5" fill="transparent" pointer-events="${interactive ? 'all' : 'none'}"/>
      <circle class="bg-gate-disc" r="9.5" fill="${active ? fill : 'transparent'}" stroke="${active ? fill.startsWith('url') ? PALETTE.ink : fill : 'none'}" stroke-width=".8" pointer-events="none"/>
      <circle class="bg-gate-highlight" data-state="${selected ? 'selected' : related ? 'related' : 'idle'}" r="8.5" fill="${active ? 'none' : PALETTE.halo}" stroke="${PALETTE.halo}" stroke-width="2" opacity="${selected || related ? 1 : 0}" pointer-events="none"/>
      <text y=".5" text-anchor="middle" dominant-baseline="central" font-family="Inter, -apple-system, BlinkMacSystemFont, sans-serif" font-size="9.9" font-weight="${active ? '650' : '500'}" fill="${active ? '#ffffff' : '#171513'}" pointer-events="none">${gate.id}</text>
    </g>`;
  }).join('');

  return `<defs>
    <linearGradient id="${prefix}-dual" x1="0%" y1="0%" x2="100%" y2="0%"><stop offset="50%" stop-color="${PALETTE.ink}"/><stop offset="50%" stop-color="${PALETTE.design}"/></linearGradient>
${thumbnail ? '' : `    <clipPath id="${prefix}-integration-inner-side" clipPathUnits="userSpaceOnUse"><path d="${INTEGRATION_INNER_SIDE}"/></clipPath>
    ${integrationOuterOwnership.map(({ gate, path }) => `<clipPath id="${prefix}-integration-outer-owner-${gate}" clipPathUnits="userSpaceOnUse"><path class="bg-integration-outer-side" d="${INTEGRATION_OUTER_SIDE}"/><path class="bg-integration-fork-side" d="${path}"/></clipPath>`).join('')}
    ${integrationEndPlanes.map(({ gate, polygon }) => `<clipPath id="${prefix}-integration-end-${gate}" clipPathUnits="userSpaceOnUse"><polygon data-terminal-gate="${gate}" points="${polygon}"/></clipPath>`).join('')}
    <!-- Single-arm outlines exclude the physical node. Complete connections also
         own a continuous exterior ring, with active neighboring paint protected. -->
    ${integrationOutlineMask(`${prefix}-integration-outline`)}
    ${selectionPath && !integrationSelected ? integrationOutlineMask(`${prefix}-integration-selection-outline`, [...highlightedArms], stemHighlighted, prefix, connectedIntegrationGates, activeIntegrationParts) : ''}
    ${integrationChannels.map(channel => integrationOutlineMask(`${prefix}-integration-focus-${channel.id}`, channel.gates, [20, 10].includes(channel.gates[0]) !== [20, 10].includes(channel.gates[1]), prefix, channel.gates, activeIntegrationParts)).join('')}`}
  </defs>
${thumbnail ? '' : `  <style>
    .bg-interactive { cursor: pointer; outline: none; }
    .bg-interactive:focus-visible .bg-gate-highlight { opacity: 1; }
    .bg-interactive:focus-visible .bg-center-highlight { opacity: 1; }
    .bg-interactive:focus-visible .bg-channel-highlight { opacity: 1; }
    .bodygraph-channels:has(> .bg-interactive[data-type="integration"][data-visual-selected="false"]:focus-visible) > .bodygraph-integration-highlights > .bg-integration-hover { opacity: 1; }
    ${integrationChannels.map(channel => `.bodygraph-channels:has(> .bg-interactive[data-integration="true"][data-id="${channel.id}"]:focus-visible) > .bodygraph-integration-highlights > .bg-integration-focus[data-highlight-channel="${channel.id}"] { opacity: var(--integration-focus-opacity, 1); }`).join('\n    ')}
    .bg-activation { cursor: pointer; outline: none; }
    .bg-activation:hover rect { fill: #f1f4f8; }
    .bg-activation:focus-visible rect { stroke: #c4d9f1; stroke-width: 1.5; }
    .planet-symbol { font-family: 'Apple Symbols', 'Segoe UI Symbol', 'Arial Unicode MS', sans-serif; }
    @media (hover: hover) {
      .bg-interactive:hover .bg-gate-highlight { opacity: 1; }
      .bg-interactive:hover .bg-center-highlight { opacity: 1; }
      .bg-interactive[data-type="channel"]:hover > .bg-channel-highlight { opacity: 1; }
      .bodygraph-channels:has(> .bg-interactive[data-type="integration"][data-visual-selected="false"]:hover) > .bodygraph-integration-highlights > .bg-integration-hover { opacity: 1; }
    }
  </style>`}
  ${options.showMandala || options.showMandalaLayer ? `<g class="mandala-scene" transform="translate(320 398) scale(${MANDALA_SCENE_SCALE}) translate(-320 -398)">${renderMandala(chart, { interactive: interactive && Boolean(options.showMandala), selectedGates: committedGates, relatedGates, pinnedCrosses: options.pinnedCrosses, previewCross: options.previewSelection?.type === 'mandala-cross' ? options.previewSelection.cross : null })}</g>\n  ` : ''}<g class="bodygraph-drawing${options.showMandala ? ' mandala-drawing' : ''}" ${interactive ? '' : 'pointer-events="none"'}>
    ${options.showActivations ? renderActivationColumns(chart, relatedGates, selection, { pressedGates: committedGates, pressedSelection: committedSelection, selections: visualSelections, pressedSelections: committedSelections, activationFilter: options.activationFilter, previewGates }) + (options.showMandala ? '' : renderVariableArrows(chart)) : ''}
    ${options.showMandala ? '<g class="mandala-core">\n    ' + renderMandalaUnderlay(prefix, { lotus: options.showLotus }) : options.showBackdrop ? renderChartBackdrop(prefix, { lotus: options.showLotus }) : ''}<g class="bodygraph-channels">${channels}${integrationHighlights}${integration}</g>
    <g class="bodygraph-centers">${centers}</g>
    ${thumbnail ? '' : `<g class="bodygraph-gates">${gates}</g>`}${options.showMandala ? '\n    </g>' : ''}
  </g>`;
}
