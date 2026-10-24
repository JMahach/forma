import { paintIntegrationLayers } from './integration-paint.ts';
import type { ChartView } from '../domain/chart-composition.ts';
import type { SelectionTarget, SelectionType } from '../selection/selection-targets.ts';
import type { RenderState, RenderOptions } from './render-state.ts';
import { PALETTE, CHANNEL_WIDTH, CHANNEL_HIGHLIGHT_WIDTH, activationLaneColor, paintGateActivation, integrationPaint, integrationOutlineMask, integrationChannels, channelPaint, centerPaint, gatePaint } from './bodygraph-paint.ts';
import { CENTERS, GATES } from './geometry/chart-geometry.ts';
import { renderActivationColumns } from './activation-columns.ts';
import { renderVariableArrows, visibleVariables } from './variable-arrows.ts';
import { renderMandala } from './mandala.ts';
import { MANDALA_SCENE_TRANSFORM } from './geometry/mandala-geometry.ts';
import { DRAWING_TRANSFORM } from './geometry/drawing-presentation.ts';
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
import { SOFT_HIGHLIGHT_DURATION } from './soft-highlight.ts';

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
    const { selected, related, defined, opacity, highlight: channelHighlight, lanes: halves } = channelPaint(channel, state, options);
    const highlight = thumbnail ? '' : channelHighlight;
    return `<g ${attrs('channel', channel.id, `Канал ${channel.id}: ${channel.name}`, selected)} data-defined="${defined}" data-related="${related}" opacity="${opacity}">
      <path class="bg-channel-outline" d="${channel.path}" fill="none" stroke="${PALETTE.outline}" stroke-width="${CHANNEL_WIDTH.outline}" stroke-linecap="round" pointer-events="none"/>
      ${highlight}
      ${thumbnail ? '' : `<path class="bg-channel-highlight" d="${channel.path}" fill="none" stroke="${PALETTE.halo}" stroke-width="${CHANNEL_HIGHLIGHT_WIDTH}" stroke-linecap="round" filter="url(#${prefix}-highlight-glow)" opacity="${selected ? 1 : 0}" pointer-events="none"/>`}
      <path d="${channel.path}" fill="none" stroke="${PALETTE.paper}" stroke-width="${CHANNEL_WIDTH.paint}" stroke-linecap="round" pointer-events="none"/>
      ${halves}
      ${thumbnail ? '' : `<path class="bg-focus-shape" d="${channel.path}" fill="none" stroke="transparent" stroke-width="19" stroke-linecap="round" pointer-events="${interactive ? 'stroke' : 'none'}"/>`}
    </g>`;
  }).join('');

  const integrationState = integrationPaint(state, options);
  const { integrationSelected, highlightedArms, integrationArmState, stemHighlighted,
    connectedIntegrationGates, activeIntegrationParts, stemOpacity, selectionPath, integrationFocusOpacity } = integrationState;
  const backgroundParts = [...integrationArmState, { path: STEM_PATH, opacity: stemOpacity }];
  const integrationOutlines = `<g class="bodygraph-integration-outlines" pointer-events="none">${backgroundParts.map(({ path, opacity }) => `<path d="${path}" fill="none" stroke="${PALETTE.outline}" stroke-width="${CHANNEL_WIDTH.outline}" stroke-linecap="round" stroke-linejoin="round" opacity="${opacity}" pointer-events="none"/>`).join('')}</g>`;
  const integrationBackground = backgroundParts.map(({ path, opacity }) => `<path d="${path}" fill="none" stroke="${PALETTE.paper}" stroke-width="${CHANNEL_WIDTH.paint}" stroke-linecap="round" stroke-linejoin="round" opacity="${opacity}" pointer-events="none"/>`).join('');
  const integrationBranches = integrationArmState.map(({ gate, highlighted, opacity }) => {
    return `<g class="bg-integration-arm" data-arm="${gate}" data-related="${highlighted}" opacity="${opacity}" pointer-events="none">

    </g>`;
  }).join('');

  // Blue replaces the integration outline above ordinary crossings (including
  // 26–44) and its own gray outlines, below white/red/black semantic interiors.
  // Filter after each child's exact ownership mask, otherwise a partial-arm
  // footprint would clip away exterior bloom. The final whole-node mask keeps
  // that bloom outside every physical interior even when a branch is dimmed.
  const integrationHighlights = thumbnail ? '' : `<g class="bodygraph-integration-highlights" filter="url(#${prefix}-highlight-glow)" mask="url(#${prefix}-integration-outline)" pointer-events="none">
    <path class="bg-integration-hover" d="${INTEGRATION_PATH}" fill="none" stroke="${PALETTE.halo}" stroke-width="${CHANNEL_HIGHLIGHT_WIDTH}" stroke-linecap="butt" stroke-linejoin="round" mask="url(#${prefix}-integration-outline)" opacity="0" pointer-events="none"/>
    ${selectionPath ? `<path class="bg-integration-selection" d="${selectionPath}" fill="none" stroke="${PALETTE.halo}" stroke-width="${CHANNEL_HIGHLIGHT_WIDTH}" stroke-linecap="${integrationSelected ? 'butt' : 'round'}" stroke-linejoin="round" mask="url(#${prefix}-${integrationSelected ? 'integration-outline' : 'integration-selection-outline'})" pointer-events="none"/>` : ''}
    ${integrationChannels.map(channel => `<path class="bg-integration-focus" data-highlight-channel="${channel.id}" d="${integrationRoute(channel.gates)}" fill="none" stroke="${PALETTE.halo}" stroke-width="${CHANNEL_HIGHLIGHT_WIDTH}" stroke-linecap="round" stroke-linejoin="round" mask="url(#${prefix}-integration-focus-${channel.id})" opacity="0" style="--integration-focus-opacity:${integrationFocusOpacity(channel)}" pointer-events="none"/>`).join('')}
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
    const { selected, defined, label, opacity, fill, stroke } = centerPaint(center, state, options);
    let labels = [center.name];
    if (center.id === 'solar') labels = ['Солнечное', 'сплетение'];
    if (center.id === 'spleen') labels = ['Селезёночный'];
    return `<g ${attrs('center', center.id, label, selected)} data-defined="${defined}" opacity="${opacity}">
      <path class="bg-center-shape" data-center-points="${center.points}" d="${shape}" fill="${fill}" stroke="${stroke}" stroke-width="1.25" stroke-linejoin="round"/>
      ${thumbnail ? '' : `<path class="bg-center-highlight" d="${shape}" fill="none" stroke="${PALETTE.halo}" stroke-width="1.25" stroke-linejoin="round" filter="url(#${prefix}-highlight-glow)" mask="url(#${prefix}-center-glow-exterior)" opacity="${selected ? 1 : 0}" pointer-events="none"/>`}
      ${options.showLabels === true ? `<text x="${center.labelX}" y="${center.labelY}" text-anchor="middle" font-family="Inter, -apple-system, BlinkMacSystemFont, sans-serif" font-size="${['spleen', 'solar'].includes(center.id) ? 7.5 : 8.5}" font-weight="500" letter-spacing=".1" fill="#171513" pointer-events="none">${labels.map((label, index) => `<tspan x="${center.labelX}" dy="${index ? 9 : 0}">${escape(label)}</tspan>`).join('')}</text>` : ''}
    </g>`;
  }).join('');

  // Bloom stays behind the semantic disc; the existing inset core and numeral
  // remain sharp above it. This prevents blue blur from tinting red/black fills.
  const gates = thumbnail ? '' : GATES.map((gate) => {
    const paint = gatePaint(gate, state, options);
    const { active, selected, related, label, opacity, fill, stroke } = paint;
    return `<g ${attrs('gate', gate.id, label, selected)} data-active="${active}" data-related="${related}" opacity="${opacity}" transform="translate(${gate.x} ${gate.y})">
      <circle r="12.5" fill="transparent" pointer-events="${interactive ? 'all' : 'none'}"/>
      <circle class="bg-gate-glow" r="9" fill="${paint.highlightFill}" stroke="${PALETTE.halo}" stroke-width="1" filter="url(#${prefix}-gate-glow)" opacity="${paint.highlightOpacity}" pointer-events="none"/>
      <circle class="bg-gate-disc" r="9.5" fill="${fill}" stroke="${stroke}" pointer-events="none"/>
      <circle class="bg-gate-highlight" data-state="${paint.highlightState}" r="9" fill="${paint.highlightFill}" stroke="${PALETTE.halo}" stroke-width="1" opacity="${paint.highlightOpacity}" pointer-events="none"/>
      <text y=".5" text-anchor="middle" dominant-baseline="central" font-family="Inter, -apple-system, BlinkMacSystemFont, sans-serif" font-size="9.9" font-weight="${paint.textWeight}" fill="${paint.textFill}" pointer-events="none">${gate.id}</text>
    </g>`;
  }).join('');

  // The center mask clips after blur, protecting both center and channel
  // interiors. Its white center strokes retain the original crisp contour.
  return `${thumbnail ? '' : `<defs>
    <linearGradient id="${prefix}-dual" x1="0%" y1="0%" x2="100%" y2="0%"><stop offset="50%" stop-color="${activationLaneColor(state, 0)}"/><stop offset="50%" stop-color="${activationLaneColor(state, 1)}"/></linearGradient>
    ${highlightGlow(`${prefix}-gate-glow`, -16, -16, 32, 32, { spread: .8, blur: 1.6, opacity: .65 })}
    ${highlightGlow(`${prefix}-highlight-glow`, -16, -16, 672, 852)}
    <mask id="${prefix}-center-glow-exterior" maskUnits="userSpaceOnUse" x="-16" y="-16" width="672" height="852">
      <rect x="-16" y="-16" width="672" height="852" fill="#ffffff"/>
      ${[...paintOrder.filter(channel => !INTEGRATION_IDS.has(channel.id)).map(channel => channel.path), INTEGRATION_PATH].map(path => `<path d="${path}" fill="none" stroke="#000000" stroke-width="${CHANNEL_WIDTH.paint}" stroke-linecap="round" stroke-linejoin="round"/>`).join('')}
      ${CENTERS.map(center => `<path d="${roundedCenter(center.points)}" fill="#000000" stroke="#ffffff" stroke-width="1.25" stroke-linejoin="round"/>`).join('')}
    </mask>
    <clipPath id="${prefix}-integration-inner-side" clipPathUnits="userSpaceOnUse"><path d="${INTEGRATION_INNER_SIDE}"/></clipPath>
    ${integrationOuterOwnership.map(({ gate, path }) => `<clipPath id="${prefix}-integration-outer-owner-${gate}" clipPathUnits="userSpaceOnUse"><path class="bg-integration-outer-side" d="${INTEGRATION_OUTER_SIDE}"/><path class="bg-integration-fork-side" d="${path}"/></clipPath>`).join('')}
    ${integrationEndPlanes.map(({ gate, polygon }) => `<clipPath id="${prefix}-integration-end-${gate}" clipPathUnits="userSpaceOnUse"><polygon data-terminal-gate="${gate}" points="${polygon}"/></clipPath>`).join('')}
    <!-- Single-arm outlines exclude the physical node. Complete connections also
         own a continuous exterior ring, with active neighboring paint protected. -->
    ${integrationOutlineMask(`${prefix}-integration-outline`)}
    ${selectionPath && !integrationSelected ? integrationOutlineMask(`${prefix}-integration-selection-outline`, [...highlightedArms], stemHighlighted, prefix, connectedIntegrationGates, activeIntegrationParts) : ''}
    ${integrationChannels.map(channel => integrationOutlineMask(`${prefix}-integration-focus-${channel.id}`, channel.gates, [20, 10].includes(channel.gates[0]) !== [20, 10].includes(channel.gates[1]), prefix, channel.gates, activeIntegrationParts)).join('')}
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
      .bg-interactive:hover .bg-center-highlight { opacity: 1; }
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
