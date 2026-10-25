import { paintIntegrationLayers } from './integration-paint.ts';
import type { ChartView } from '../domain/chart-composition.ts';
import type { SelectionTarget, SelectionType } from '../selection/selection-targets.ts';
import type { RenderState, RenderOptions } from './render-state.ts';
import { PALETTE, CHANNEL_WIDTH, CHANNEL_HIGHLIGHT_INNER_WIDTH, activationLaneColor, paintGateActivation, integrationPaint, integrationHighlightPaint, integrationOutlineMask, integrationChannels, channelPaint, centerPaint, gatePaint } from './bodygraph-paint.ts';
import { CENTERS, GATES } from './geometry/chart-geometry.ts';
import { renderActivationColumns } from './activation-columns.ts';
import { renderVariableArrows, visibleVariables } from './variable-arrows.ts';
import { renderMandala } from './mandala.ts';
import { MANDALA_SCENE_TRANSFORM } from './geometry/mandala-geometry.ts';
import { DRAWING_TRANSFORM, HIGHLIGHT_OUTLINE, GATE_MARKER, CENTER_STROKE, channelHighlightWidth } from './geometry/drawing-presentation.ts';
import { ACTIVATION_COLUMN_REVEAL_DISTANCE } from './geometry/activation-layout.ts';
import { renderChartBackdrop } from './backdrop.ts';
import { INTEGRATION_IDS } from '../domain/topology.ts';
import {
  roundedCenter, paintOrder,
  STEM_PATH, INTEGRATION_PATH, INTEGRATION_INNER_SIDE,
  INTEGRATION_OUTER_SIDE, integrationOuterOwnership, integrationEndPlanes, integrationRoute,
} from './geometry/drawing-geometry.ts';
import { createRenderState, isSelectionPressed } from './render-state.ts';
import { escapeHtml as escape } from '../ui/html.ts';
import { createGateLabelRenderer } from './gate-label.ts';
import { SOFT_HIGHLIGHT_DURATION } from './soft-highlight.ts';

// The semantic figures keep their authored sizes. Only decoration grows.
const CENTER_HIGHLIGHT_INNER_WIDTH = CENTER_STROKE + HIGHLIGHT_OUTLINE.centerGap * 2;
const CENTER_HIGHLIGHT_WIDTH = CENTER_HIGHLIGHT_INNER_WIDTH + HIGHLIGHT_OUTLINE.width * 2;

// SmoothUI Border Beam's core/halo layering, frozen on our native contours.
// Widen only the soft halo, keeping the requested thin SourceGraphic sharp.
// Both layers retain Forma's exact blue rather than tinting it toward white.
function highlightGlow(id: string, x: number, y: number, width: number, height: number,
  halo = { spread: 1.6, blur: 2.4, opacity: 1 }) {
  return `<filter id="${id}" filterUnits="userSpaceOnUse" x="${x}" y="${y}" width="${width}" height="${height}" color-interpolation-filters="sRGB">
      <feMorphology in="SourceGraphic" operator="dilate" radius="${halo.spread}" result="halo-wide"/>
      <feGaussianBlur in="halo-wide" stdDeviation="${halo.blur}" result="halo-blur"/>
      <feComponentTransfer in="halo-blur" result="halo"><feFuncA type="linear" slope="${halo.opacity}"/></feComponentTransfer>
      <feMerge><feMergeNode in="halo"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>`;
}

/**
 * SVG inner markup, for a parent SVG with viewBox="0 0 640 820".
 * chart: a composition or physical chart. Topology and activation owners stay separate.
 * selection: null | {type: 'gate' | 'center' | 'channel' | 'integration', id}.
 * options: { profile?: 'studio' | 'thumbnail', interactive?: boolean, idPrefix?: string, showLabels?: boolean, dimInactive?: boolean,
 *   showActivations?: boolean, selections?: Array<typeof selection>, previewSelection?: typeof selection }.
 * Preview paint is added to the pinned selection without changing pressed state.
 * The parent owns gestures, event delegation, and persisted view transforms.
 * The studio profile gives the complete drawing one permanent presentation
 * transform. Standalone illustrations and thumbnails use their own viewBox.
 */
export function renderBodygraph(chart: ChartView = {}, selection: SelectionTarget | null = null, options: RenderOptions = {}) {
  const thumbnail = options.profile === 'thumbnail';
  if (thumbnail) {
    // A library image is an unselected physical chart. Keep this one explicit
    // profile separate from interactive:false: static stories can show choices.
    selection = null;
    options = { profile: 'thumbnail', idPrefix: options.idPrefix, interactive: false,
      showActivations: false, showLabels: false, showBackdrop: true };
  }
  return renderBodygraphState(chart, createRenderState(chart, selection, options), options);
}

// Render an already prepared snapshot. The persistent scene shares this exact
// first SVG, then adopts its state instead of repainting it immediately.
export function renderBodygraphState(chart: ChartView, state: RenderState, options: RenderOptions = {},
  variables = renderVariableArrows(chart, visibleVariables(chart, options))) {
  const thumbnail = options.profile === 'thumbnail';
  const glow = options.highlightStyle === 'glow';
  const highlightWidth = channelHighlightWidth(options.highlightStyle);
  const maskForIntegration = (id: string, gates?: readonly number[], stem?: boolean, maskPrefix?: string, connected?: readonly number[], active?: readonly string[]) =>
    integrationOutlineMask(id, gates, stem, maskPrefix, connected, active, options.highlightStyle);
  const {
    committedSelection, committedSelections, visualSelections,
    definedChannels, interactive, prefix, relatedChannels, relatedGates,
    selectedChannels, committedGates, previewGates,
  } = state;
  const attrs = (type: SelectionType, id: string | number, label: string, pressed: boolean) => {
    pressed = isSelectionPressed(state, type, id, pressed);
    return `data-type="${type}" data-id="${escape(id)}"`
      + (interactive ? ` class="bg-interactive" tabindex="0" role="button" aria-label="${escape(label)}" aria-pressed="${Boolean(pressed)}"` : '');
  };
  const channels = paintOrder.map((channel) => {
    if (INTEGRATION_IDS.has(channel.id)) return '';
    const { selected, related, defined, opacity, highlight: channelHighlight, highlightColor, lanes: halves } = channelPaint(channel, state, options);
    const highlight = thumbnail ? '' : channelHighlight;
    return `<g ${attrs('channel', channel.id, `Канал ${channel.id}: ${channel.name}`, selected)} data-defined="${defined}" data-related="${related}" opacity="${opacity}">
      <path class="bg-channel-outline" d="${channel.path}" fill="none" stroke="${PALETTE.outline}" stroke-width="${CHANNEL_WIDTH.outline}" stroke-linecap="round" pointer-events="none"/>
      ${highlight}
      ${thumbnail ? '' : `<path class="bg-channel-highlight" d="${channel.path}" fill="none" stroke="${highlightColor}" stroke-width="${highlightWidth}" stroke-linecap="round" ${glow ? `filter="url(#${prefix}-highlight-glow)"` : `mask="url(#${prefix}-highlight-exterior)"`} opacity="${selected ? 1 : 0}" pointer-events="none"/>`}
      <path d="${channel.path}" fill="none" stroke="${PALETTE.paper}" stroke-width="${CHANNEL_WIDTH.paint}" stroke-linecap="round" pointer-events="none"/>
      ${halves}
      ${thumbnail ? '' : `<path class="bg-focus-shape" d="${channel.path}" fill="none" stroke="transparent" stroke-width="19" stroke-linecap="round" pointer-events="${interactive ? 'stroke' : 'none'}"/>`}
    </g>`;
  }).join('');

  const integrationState = integrationPaint(state, options);
  const integrationHighlight = integrationHighlightPaint(state, options);
  const { integrationSelected, highlightedArms, integrationArmState, stemHighlighted,
    connectedIntegrationGates, activeIntegrationParts, stemOpacity, selectionPath, integrationFocusOpacity } = integrationState;
  const backgroundParts = [...integrationArmState, { path: STEM_PATH, opacity: stemOpacity }];
  const integrationOutlines = `<g class="bodygraph-integration-outlines" pointer-events="none">${backgroundParts.map(({ path, opacity }) => `<path d="${path}" fill="none" stroke="${PALETTE.outline}" stroke-width="${CHANNEL_WIDTH.outline}" stroke-linecap="round" stroke-linejoin="round" opacity="${opacity}" pointer-events="none"/>`).join('')}</g>`;
  const integrationBackground = backgroundParts.map(({ path, opacity }) => `<path d="${path}" fill="none" stroke="${PALETTE.paper}" stroke-width="${CHANNEL_WIDTH.paint}" stroke-linecap="round" stroke-linejoin="round" opacity="${opacity}" pointer-events="none"/>`).join('');
  const integrationBranches = integrationArmState.map(({ gate, highlighted, opacity }) => {
    return `<g class="bg-integration-arm" data-arm="${gate}" data-related="${highlighted}" opacity="${opacity}" pointer-events="none">

    </g>`;
  }).join('');

  // Child ownership masks preserve the authored integration cuts. Their inner
  // subtraction now includes a gap; no blur or color covers the physical node.
  const integrationHighlights = thumbnail ? '' : `<g class="bodygraph-integration-highlights" ${glow ? `filter="url(#${prefix}-highlight-glow)" mask="url(#${prefix}-integration-outline)"` : `mask="url(#${prefix}-highlight-exterior)"`} pointer-events="none">
    <path class="bg-integration-hover" d="${INTEGRATION_PATH}" fill="none" stroke="${integrationHighlight.color}" stroke-width="${highlightWidth}" stroke-linecap="butt" stroke-linejoin="round" mask="url(#${prefix}-integration-outline)" opacity="0" pointer-events="none"/>
    ${selectionPath ? `<path class="bg-integration-selection" d="${selectionPath}" fill="none" stroke="${integrationHighlight.color}" stroke-width="${highlightWidth}" stroke-linecap="${integrationSelected ? 'butt' : 'round'}" stroke-linejoin="round" mask="url(#${prefix}-${integrationSelected ? 'integration-outline' : 'integration-selection-outline'})" pointer-events="none"/>` : ''}
    ${integrationChannels.map(channel => `<path class="bg-integration-focus" data-highlight-channel="${channel.id}" d="${integrationRoute(channel.gates)}" fill="none" stroke="${integrationHighlight.color}" stroke-width="${highlightWidth}" stroke-linecap="round" stroke-linejoin="round" mask="url(#${prefix}-integration-focus-${channel.id})" opacity="0" style="--integration-focus-opacity:${integrationFocusOpacity(channel)}" pointer-events="none"/>`).join('')}
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
    <g class="bodygraph-integration-paint" pointer-events="none">${paintIntegrationLayers(state)}</g>
    ${thumbnail ? '' : `<path d="${INTEGRATION_PATH}" fill="none" stroke="transparent" stroke-width="20" stroke-linecap="round" pointer-events="${interactive ? 'stroke' : 'none'}"/>`}
  </g>${integrationSelectors}`;

  const centers = CENTERS.map((center) => {
    const shape = roundedCenter(center.points);
    const { selected, defined, label, opacity, fill, stroke, highlightColor } = centerPaint(center, state, options);
    let labels = [center.name];
    if (center.id === 'solar') labels = ['Солнечное', 'сплетение'];
    if (center.id === 'spleen') labels = ['Селезёночный'];
    return `<g ${attrs('center', center.id, label, selected)} data-defined="${defined}" opacity="${opacity}">
      <path class="bg-center-shape" data-center-points="${center.points}" d="${shape}" fill="${fill}" stroke="${stroke}" stroke-width="${CENTER_STROKE}" stroke-linejoin="round"/>
      ${thumbnail ? '' : `<path class="bg-center-highlight" d="${shape}" fill="none" stroke="${highlightColor}" stroke-width="${glow ? CENTER_STROKE : CENTER_HIGHLIGHT_WIDTH}" stroke-linejoin="round" ${glow ? `filter="url(#${prefix}-highlight-glow)" mask="url(#${prefix}-center-glow-exterior)"` : `mask="url(#${prefix}-highlight-exterior)"`} opacity="${selected ? 1 : 0}" pointer-events="none"/>`}
      ${options.showLabels === true ? `<text x="${center.labelX}" y="${center.labelY}" text-anchor="middle" font-family="Inter, -apple-system, BlinkMacSystemFont, sans-serif" font-size="${['spleen', 'solar'].includes(center.id) ? 7.5 : 8.5}" font-weight="500" letter-spacing=".1" fill="#171513" pointer-events="none">${labels.map((label, index) => `<tspan x="${center.labelX}" dy="${index ? 9 : 0}">${escape(label)}</tspan>`).join('')}</text>` : ''}
    </g>`;
  }).join('');

  // The smaller circle and its thin edge fit inside the previous footprint.
  const gateLabel = thumbnail ? null : createGateLabelRenderer();
  const gates = thumbnail ? '' : GATES.map((gate) => {
    const paint = gatePaint(gate, state, options);
    const { active, selected, related, label, opacity, fill, stroke } = paint;
    return `<g ${attrs('gate', gate.id, label, selected)} data-active="${active}" data-related="${related}" opacity="${opacity}" transform="translate(${gate.x} ${gate.y})">
      <circle r="${GATE_MARKER.hitRadius}" fill="transparent" pointer-events="${interactive ? 'all' : 'none'}"/>
      ${glow ? `<circle class="bg-gate-glow" r="${GATE_MARKER.radius}" fill="${paint.highlightFill}" stroke="${paint.highlightColor}" stroke-width="${GATE_MARKER.highlightWidth}" filter="url(#${prefix}-gate-glow)" opacity="${paint.highlightOpacity}" pointer-events="none"/>
      <circle class="bg-gate-disc" r="${GATE_MARKER.radius}" fill="${fill}" stroke="${stroke}" pointer-events="none"/>
      <circle class="bg-gate-highlight" data-state="${paint.highlightState}" r="${GATE_MARKER.radius}" fill="${paint.highlightFill}" stroke="${paint.highlightColor}" stroke-width="${GATE_MARKER.highlightWidth}" opacity="${paint.highlightOpacity}" pointer-events="none"/>` : `<circle class="bg-gate-disc" r="${GATE_MARKER.radius}" fill="${fill}" stroke="${stroke}" pointer-events="none"/>
      <circle class="bg-gate-glow" r="${GATE_MARKER.radius}" fill="none" stroke="${paint.highlightColor}" stroke-width="${GATE_MARKER.highlightWidth}" opacity="${paint.highlightOpacity}" pointer-events="none"/>
      <circle class="bg-gate-highlight" data-state="${paint.highlightState}" r="${GATE_MARKER.radius}" fill="${paint.highlightFill}" stroke="none" opacity="${paint.highlightOpacity}" pointer-events="none"/>`}
      ${gateLabel!(gate.id, paint.textFill)}
    </g>`;
  }).join('');

  // One inner union clips every exterior ring. At a center/channel junction,
  // neither ring can continue inside the other figure or its gap.
  return `${thumbnail ? '' : `<defs>
    <g class="bg-integration-color-defs">${integrationHighlight.definitions}</g>
    <linearGradient id="${prefix}-dual" x1="0%" y1="0%" x2="100%" y2="0%"><stop offset="50%" stop-color="${activationLaneColor(state, 0)}"/><stop offset="50%" stop-color="${activationLaneColor(state, 1)}"/></linearGradient>
    ${glow ? `${highlightGlow(`${prefix}-gate-glow`, -16, -16, 32, 32, { spread: .8, blur: 1.6, opacity: .65 })}
    ${highlightGlow(`${prefix}-highlight-glow`, -16, -16, 672, 852)}
    <mask id="${prefix}-center-glow-exterior" maskUnits="userSpaceOnUse" x="-16" y="-16" width="672" height="852">
      <rect x="-16" y="-16" width="672" height="852" fill="#ffffff"/>
      ${[...paintOrder.filter(channel => !INTEGRATION_IDS.has(channel.id)).map(channel => channel.path), INTEGRATION_PATH].map(path => `<path d="${path}" fill="none" stroke="#000000" stroke-width="${CHANNEL_WIDTH.paint}" stroke-linecap="round" stroke-linejoin="round"/>`).join('')}
      ${CENTERS.map(center => `<path d="${roundedCenter(center.points)}" fill="#000000" stroke="#ffffff" stroke-width="${CENTER_STROKE}" stroke-linejoin="round"/>`).join('')}
    </mask>` : `<mask id="${prefix}-highlight-exterior" maskUnits="userSpaceOnUse" x="-16" y="-16" width="672" height="852">
      <rect x="-16" y="-16" width="672" height="852" fill="#ffffff"/>
      ${[...paintOrder.filter(channel => !INTEGRATION_IDS.has(channel.id)).map(channel => channel.path), INTEGRATION_PATH].map(path => `<path d="${path}" fill="none" stroke="#000000" stroke-width="${CHANNEL_HIGHLIGHT_INNER_WIDTH}" stroke-linecap="round" stroke-linejoin="round"/>`).join('')}
      ${CENTERS.map(center => `<path d="${roundedCenter(center.points)}" fill="#000000" stroke="#000000" stroke-width="${CENTER_HIGHLIGHT_INNER_WIDTH}" stroke-linejoin="round"/>`).join('')}
    </mask>`}
    <clipPath id="${prefix}-integration-inner-side" clipPathUnits="userSpaceOnUse"><path d="${INTEGRATION_INNER_SIDE}"/></clipPath>
    ${integrationOuterOwnership.map(({ gate, path }) => `<clipPath id="${prefix}-integration-outer-owner-${gate}" clipPathUnits="userSpaceOnUse"><path class="bg-integration-outer-side" d="${INTEGRATION_OUTER_SIDE}"/><path class="bg-integration-fork-side" d="${path}"/></clipPath>`).join('')}
    ${integrationEndPlanes.map(({ gate, polygon }) => `<clipPath id="${prefix}-integration-end-${gate}" clipPathUnits="userSpaceOnUse"><polygon data-terminal-gate="${gate}" points="${polygon}"/></clipPath>`).join('')}
    <!-- Single-arm outlines exclude the physical node. Complete connections also
         own a continuous exterior ring, with active neighboring paint protected. -->
    ${maskForIntegration(`${prefix}-integration-outline`)}
    ${selectionPath && !integrationSelected ? maskForIntegration(`${prefix}-integration-selection-outline`, [...highlightedArms], stemHighlighted, prefix, connectedIntegrationGates, activeIntegrationParts) : ''}
    ${integrationChannels.map(channel => maskForIntegration(`${prefix}-integration-focus-${channel.id}`, channel.gates, [20, 10].includes(channel.gates[0]) !== [20, 10].includes(channel.gates[1]), prefix, channel.gates, activeIntegrationParts)).join('')}
  </defs>`}
${thumbnail ? '' : `  <style>
    .bg-interactive { cursor: pointer; outline: none; }
    .bg-interactive:focus-visible .bg-gate-highlight { opacity: 1; }
    .bg-interactive:focus-visible .bg-gate-glow { opacity: 1; }
    .bg-interactive:focus-visible .bg-center-highlight { opacity: 1; }
    .bg-interactive:focus-visible .bg-channel-highlight { opacity: 1; }
    .bodygraph-channels:has(> .bg-interactive[data-type="integration"][data-visual-selected="false"]:focus-visible) > .bodygraph-integration-highlights > .bg-integration-hover { opacity: 1; }
    ${integrationChannels.map(channel => `.bodygraph-channels:has(> .bg-interactive[data-integration="true"][data-id="${channel.id}"]:focus-visible) > .bodygraph-integration-highlights > .bg-integration-focus[data-highlight-channel="${channel.id}"] { opacity: var(--integration-focus-opacity, 1); transition-duration: ${SOFT_HIGHLIGHT_DURATION.enter}ms; }`).join('\n    ')}
    .bg-activation { cursor: pointer; outline: none; -webkit-tap-highlight-color: transparent; }
    /* Safari needs explicit inheritance to keep the line suffix on the gate baseline. */
    .bg-activation tspan { dominant-baseline: inherit; }
    .bg-activation[data-fluid-active="true"] > rect { fill: transparent; }
    .bg-activation[aria-pressed="true"] > rect { stroke: ${PALETTE.halo}; stroke-width: 2; }
    .bg-activation:focus-visible rect { stroke: ${PALETTE.halo}; stroke-width: 1.5; }
    .planet-symbol { font-family: 'Apple Symbols', 'Segoe UI Symbol', 'Arial Unicode MS', sans-serif; }
    @media (hover: hover) {
      .bg-interactive:hover .bg-gate-highlight { opacity: 1; }
      .bg-interactive:hover .bg-gate-glow { opacity: 1; }
      .bg-interactive[data-type="channel"]:hover > .bg-channel-highlight { opacity: 1; }
      .bodygraph-channels:has(> .bg-interactive[data-type="integration"][data-visual-selected="false"]:hover) > .bodygraph-integration-highlights > .bg-integration-hover { opacity: 1; }
    }
  </style>`}
  ${options.showMandala || options.showMandalaLayer ? `<g class="mandala-scene" transform="${MANDALA_SCENE_TRANSFORM}">${renderMandala(chart, { interactive: interactive && Boolean(options.showMandala), selectedGates: committedGates, relatedGates, pinnedCrosses: options.pinnedCrosses, previewCross: options.previewSelection?.type === 'mandala-cross' ? options.previewSelection.cross : null })}</g>\n  ` : ''}<g class="bodygraph-drawing${options.showMandala ? ' mandala-drawing' : ''}"${options.profile === 'studio' ? ` transform="${DRAWING_TRANSFORM}"` : ''} style="--activation-column-expanded-offset:${ACTIVATION_COLUMN_REVEAL_DISTANCE}px" ${interactive ? '' : 'pointer-events="none"'}>
    ${options.showActivations ? renderActivationColumns(chart, relatedGates, committedSelection, { pressedGates: committedGates, pressedSelection: committedSelection, selections: visualSelections, pressedSelections: committedSelections, previewGates, showMandala: options.showMandala }) + variables : ''}
    ${options.showMandala ? renderChartBackdrop(prefix, { mandala: true }) : options.showBackdrop ? renderChartBackdrop(prefix) : ''}<g class="bodygraph-channels">${channels}${integrationOutlines}${integrationHighlights}${integration}</g>
    <g class="bodygraph-centers">${centers}</g>
    ${thumbnail ? '' : `<g class="bodygraph-gates">${gates}</g>`}
  </g>`;
}
