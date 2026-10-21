import type { RenderState, RenderOptions } from './render-state.ts';
import type { CENTERS } from './geometry/chart-geometry.ts';
import { CHANNELS, GATES } from './geometry/chart-geometry.ts';
import { STEM_POINTS } from './geometry/integration-geometry.ts';
import { INTEGRATION_IDS } from '../domain/topology.ts';
import { OVERLAY_PALETTE } from '../ui/overlay-palette.ts';
import { pointString, offsetPoints, splitAtHalfLength, channelHalves, INTEGRATION_ARMS, STEM_PATH, INTEGRATION_PATH } from './geometry/drawing-geometry.ts';
import { PALETTE } from '../ui/chart-palette.ts';
export { PALETTE } from '../ui/chart-palette.ts';

import { CHANNEL_WIDTH } from './geometry/drawing-presentation.ts';
export { CHANNEL_WIDTH } from './geometry/drawing-presentation.ts';

export function integrationOutlineMask(id: string, gates: readonly number[] = [20, 10, 34, 57], includeStem = true, prefix = 'bodygraph', connectedGates: readonly number[] = [], activeParts: readonly string[] = []) {
  const whole = gates.length === 4 && includeStem;
  const owned = whole ? '' : INTEGRATION_ARMS.filter(({ gate }) => gates.includes(gate)).map(({ gate, path }) => {
    const outer = gate === 20 || gate === 57;
    const clip = outer ? `${prefix}-integration-end-${gate}` : `${prefix}-integration-inner-side`;
    const footprint = `<path class="bg-integration-owned-arm" data-owner-gate="${gate}" d="${path}" fill="none" stroke="#ffffff" stroke-width="${CHANNEL_WIDTH.halo}" stroke-linecap="${outer ? 'round' : 'butt'}" stroke-linejoin="round" clip-path="url(#${clip})"/>`;
    return outer ? `<g clip-path="url(#${prefix}-integration-outer-owner-${gate})">${footprint}</g>` : footprint;
  }).join('') + (includeStem ? `<path class="bg-integration-owned-stem" d="${STEM_PATH}" fill="none" stroke="#ffffff" stroke-width="${CHANNEL_WIDTH.halo}" stroke-linecap="butt" stroke-linejoin="round"/>` : '');
  // Only a route through the shared stem needs an extra continuous ring.
  // Same-fork pairs (10–20, 34–57) retain the two approved arm cuts: a round
  // footprint here would extend past the terminal plane into the unselected
  // stem. Gate, center, hover and keyboard selections share this one policy.
  const connectedParts = !whole && includeStem && connectedGates.length >= 2
    ? [...INTEGRATION_ARMS.filter(({ gate }) => connectedGates.includes(gate)).map(({ path }) => path), STEM_PATH] : [];
  const connectedPath = connectedParts.join(' ');
  const occludedPath = activeParts.filter(path => !connectedParts.includes(path)).join(' ');
  const continuous = connectedPath
    ? `<path class="bg-integration-connected-footprint" d="${connectedPath}" fill="none" stroke="#ffffff" stroke-width="${CHANNEL_WIDTH.halo}" stroke-linecap="round" stroke-linejoin="round"/><path class="bg-integration-connected-interior" d="${connectedPath}" fill="none" stroke="#000000" stroke-width="${CHANNEL_WIDTH.outline}" stroke-linecap="round" stroke-linejoin="round"/>${occludedPath ? `<path class="bg-integration-connected-occlusion" d="${occludedPath}" fill="none" stroke="#000000" stroke-width="${CHANNEL_WIDTH.outline}" stroke-linecap="round" stroke-linejoin="round"/>` : ''}` : '';
  return `<mask id="${id}" maskUnits="userSpaceOnUse" x="0" y="0" width="640" height="820"><rect x="0" y="0" width="640" height="820" fill="${whole ? '#ffffff' : '#000000'}"/>${owned}<path class="bg-integration-interior" d="${INTEGRATION_PATH}" fill="none" stroke="#000000" stroke-width="${CHANNEL_WIDTH.outline}" stroke-linecap="round" stroke-linejoin="round"/>${continuous}</mask>`;
}


export const integrationChannels = CHANNELS.filter(channel => INTEGRATION_IDS.has(channel.id));
const stemHalves = splitAtHalfLength(STEM_POINTS);
export const armPaintPoints = new Map(INTEGRATION_ARMS.map(arm => [arm.gate, arm.reversePaint ? [...arm.points].reverse() : arm.points]));
// The catalogue of stroke paths is finite; geometry is prepared once, not on a minute/hover update.
const strokePaths = new WeakMap<number[][], Map<number, string>>();
function stroke(points: number[][], color: string, width: number, offset = 0) {
  let paths = strokePaths.get(points);
  if (!paths) { paths = new Map(); strokePaths.set(points, paths); }
  if (!paths.has(offset)) paths.set(offset, pointString(offset ? offsetPoints(points, offset) : points));
  return `<path d="${paths.get(offset)}" fill="none" stroke="${color}" stroke-width="${width}" stroke-linecap="butt" stroke-linejoin="round" pointer-events="none"/>`;
}
// Lane order is shared by channel paint and the gate disc's two gradient halves.
export const activationLaneColor = (state: RenderState, lane: number) => state.overlaySources
  ? OVERLAY_PALETTE[lane === 0 ? 'cycle' : 'natal'] : PALETTE[lane === 0 ? 'ink' : 'design'];
const paintActivation = (points: number[][], first: boolean, second: boolean, state: RenderState) => first && second
  ? stroke(points, activationLaneColor(state, 0), CHANNEL_WIDTH.lane, -CHANNEL_WIDTH.laneOffset) + stroke(points, activationLaneColor(state, 1), CHANNEL_WIDTH.lane, CHANNEL_WIDTH.laneOffset)
  : first || second ? stroke(points, activationLaneColor(state, first ? 0 : 1), CHANNEL_WIDTH.paint) : '';

// General graph paint shows two origins. The four independent source bits
// remain in the snapshot for exact activation details and cache ownership.
export function paintGateActivation(points: number[][], state: RenderState, gates: number | readonly number[]) {
  const ids = (Array.isArray(gates) ? gates : [gates]) as readonly number[];
  if (!state.overlaySources) return paintActivation(points,
    ids.some(gate => state.personality.has(gate)), ids.some(gate => state.design.has(gate)), state);
  const mask = ids.reduce((value, gate) => value | (state.overlaySources!.masks.get(gate) || 0), 0);
  return paintActivation(points, Boolean(mask & 12), Boolean(mask & 3), state);
}

// The static SVG and persistent painter use the same visual decisions.
export function channelPaint(channel: typeof CHANNELS[number], state: RenderState, options: RenderOptions = {}) {
  const selected = state.selectedChannels.has(channel.id), related = state.relatedChannels.has(channel.id);
  const active = channel.gates.some(gate => state.personality.has(gate) || state.design.has(gate));
  return { selected, related, defined: state.definedChannels.has(channel.id),
    opacity: options.dimInactive && !active && !related ? .2 : 1,
    highlight: selected ? '' : channelHalves.get(channel.id)!.map((points, index) => state.halfGates.has(channel.gates[index])
      ? `<g data-highlight-gate="${channel.gates[index]}">${stroke(points, PALETTE.halo, CHANNEL_WIDTH.halo)}</g>` : '').join(''),
    lanes: channelHalves.get(channel.id)!.map((points, index) => paintGateActivation(points, state, channel.gates[index])).join(''),
  };
}

export function centerPaint(center: typeof CENTERS[number], state: RenderState, options: RenderOptions = {}) {
  // Completing a center's gates outlines it without creating a pinned item.
  const selected = state.selectedCenters.has(center.id)
    || GATES.filter(gate => gate.center === center.id).every(gate => state.selectedGates.has(gate.id));
  const defined = state.definition.centers.has(center.id);
  const secondOrigin = state.overlaySources?.kind === 'transit' ? 'транзита' : 'возврата';
  const ownership = !state.overlaySources || !defined ? '' : state.overlaySources.natal.centers.has(center.id)
    ? ', определён в натале' : state.overlaySources.cycle.centers.has(center.id)
      ? `, определён в карте ${secondOrigin}` : `, определён только в соединении натала и ${secondOrigin}`;
  return { selected, defined, label: `${center.name} центр, ${defined ? 'определён' : 'не определён'}${ownership}`,
    opacity: options.dimInactive && !defined && !selected ? .45 : 1,
    fill: defined ? PALETTE[center.id as keyof typeof PALETTE] : PALETTE.paper, stroke: defined ? '#84715b' : '#b4b0a7' };
}

export function gatePaint(gate: typeof GATES[number], state: RenderState, options: RenderOptions = {}) {
  const mask = state.overlaySources?.masks.get(gate.id) || 0;
  const black = state.overlaySources ? Boolean(mask & 12) : state.personality.has(gate.id);
  const red = state.overlaySources ? Boolean(mask & 3) : state.design.has(gate.id);
  const active = black || red;
  const selected = state.selectedGates.has(gate.id), related = state.relatedGates.has(gate.id);
  const fill = black && red ? `url(#${state.prefix}-dual)` : black ? activationLaneColor(state, 0) : red ? activationLaneColor(state, 1) : PALETTE.paper;
  const source = state.overlaySources ? state.overlaySources.sources.filter(source => source.gates.has(gate.id)).map(source => source.label).join('; ') || 'не активированы'
    : black && red ? 'личность и дизайн' : black ? 'личность' : red ? 'дизайн' : 'не активированы';
  return { active, selected, related, label: `Ворота ${gate.id}: ${gate.name}, ${source}`,
    opacity: options.dimInactive && !active && !selected && !related ? .3 : 1,
    fill: active ? fill : 'transparent', stroke: 'none',
    highlightState: selected ? 'selected' : related ? 'related' : 'idle',
    highlightFill: active ? 'none' : PALETTE.halo, highlightOpacity: selected || related ? 1 : 0,
    textWeight: active ? '650' : '500', textFill: active ? '#ffffff' : '#171513' };
}

export function integrationStemPaint(state: RenderState, paint: ReturnType<typeof integrationPaint>) {
  return paint.crossesStem ? stemHalves.map((points, index) => {
    const gates = index ? [34, 57] : [20, 10];
    return paintGateActivation(points, state, gates);
  }).join('') : '';
}
export function integrationPaint(state: RenderState, options: RenderOptions) {
  const { visualSelections, selectedChannels, halfGates, personality, design, relatedChannels } = state;
  const integrationSelected = visualSelections.some(value => value.type === 'integration');
  // Gates selected individually or through their centers complete the same
  // visual route as their channel, without pinning another selection item.
  // Hover contributes only preview gates; channel endpoint scopes stay atomic.
  const selectedIntegrationChannels = integrationChannels.filter(channel => selectedChannels.has(channel.id)
    || channel.gates.every(id => halfGates.has(id)));
  const highlightedArms = new Set(integrationSelected ? [20, 10, 34, 57]
    : [...selectedIntegrationChannels.flatMap(channel => channel.gates), ...INTEGRATION_ARMS.filter(({ gate }) => halfGates.has(gate)).map(({ gate }) => gate)]);
  const integrationArmState = INTEGRATION_ARMS.map((arm) => {
    const { gate } = arm;
    const active = personality.has(gate) || design.has(gate);
    const highlighted = highlightedArms.has(gate);
    const opacity = options.dimInactive && !active && !highlighted ? 0.2 : 1;
    return { ...arm, active, highlighted, opacity };
  });
  const active = (gate: number) => personality.has(gate) || design.has(gate);
  const crossesStem = [20, 10].some(active) && [34, 57].some(active);
  const stemHighlighted = integrationSelected || selectedIntegrationChannels.some(channel => [20, 10].includes(channel.gates[0]) !== [20, 10].includes(channel.gates[1]));
  const connectedIntegrationGates = [...new Set(selectedIntegrationChannels.flatMap(channel => channel.gates))];
  const activeIntegrationParts = [...integrationArmState.filter(({ active }) => active).map(({ path }) => path), ...(crossesStem ? [STEM_PATH] : [])];
  const stemOpacity = options.dimInactive && !crossesStem && !stemHighlighted ? 0.2 : 1;

  const selectionPath = integrationSelected ? INTEGRATION_PATH
    : [...INTEGRATION_ARMS.filter(({ gate }) => highlightedArms.has(gate)).map(({ path }) => path), ...(stemHighlighted ? [STEM_PATH] : [])].join(' ');
  const integrationFocusOpacity = (channel: typeof CHANNELS[number]) => options.dimInactive && !channel.gates.some(active) && !relatedChannels.has(channel.id) ? 0.2 : 1;
  return { integrationSelected, highlightedArms, integrationArmState, crossesStem, stemHighlighted,
    connectedIntegrationGates, activeIntegrationParts, stemOpacity, selectionPath, integrationFocusOpacity };
}
