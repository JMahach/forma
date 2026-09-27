import { CENTERS, GATES, getChannel } from './geometry/chart-geometry.js';
import { INTEGRATION_IDS } from '../domain/topology.js';
import { paintOrder, channelHalves, INTEGRATION_PATH } from './geometry/drawing-geometry.js';
import { PALETTE, CHANNEL_WIDTH, stroke, paintActivation, integrationPaint,
  integrationOutlineMask, integrationChannels, stemHalves, armPaintPoints } from './bodygraph-paint.js';
import { setAttribute, setAttributes, fragmentSlot, svgNodes } from './svg-patches.js';

const selectedCenter = (center, state) => state.selectedCenters.has(center.id)
  || GATES.filter(gate => gate.center === center.id).every(gate => state.selectedGates.has(gate.id));
const coreKey = (state, options) => [state.personality, state.design, state.relatedChannels,
  state.relatedGates, state.halfGates, state.selectedGates, state.selectedCenters,
  state.selectedChannels].map(set => [...set].join(',')).join('|')
  + JSON.stringify([state.committedSelections, state.visualSelections.some(v => v.type === 'integration'),
    Boolean(options.previewSelection || options.selections), options.dimInactive]);

// Targets never change identity when a minute, activation or selection changes.
// Only a channel's variable lanes and the small integration masks are fragments.
export function createBodygraphPainter(root) {
  const drawing = root.querySelector('.bodygraph-drawing');
  const byType = (type, id) => drawing.querySelector(`.bodygraph-${type === 'gate' ? 'gates' : type === 'center' ? 'centers' : 'channels'} [data-type="${type}"][data-id="${id}"]`);
  const channels = paintOrder.filter(channel => !INTEGRATION_IDS.has(channel.id)).map(channel => {
    const node = byType('channel', channel.id);
    const halo = node.querySelector('.bg-channel-highlight');
    const outline = node.querySelector('.bg-channel-outline');
    const hit = node.querySelector('.bg-focus-shape');
    const children = [...node.children], paper = children[children.indexOf(outline) + 1];
    return { channel, node, halo,
      highlight: fragmentSlot(node, halo, children.slice(0, children.indexOf(halo))),
      lanes: fragmentSlot(node, hit, children.slice(children.indexOf(paper) + 1, children.indexOf(hit))) };
  });
  const centers = CENTERS.map(center => { const node = byType('center', center.id); return { center, node,
    shape: node.querySelector('.bg-center-shape'), halo: node.querySelector('.bg-center-highlight') }; });
  const gates = GATES.flatMap(gate => { const node = byType('gate', gate.id); return node ? [{ gate, node,
    disc: node.querySelector('.bg-gate-disc'), halo: node.querySelector('.bg-gate-highlight'), text: node.querySelector('text') }] : []; });
  const integration = byType('integration', 'integration');
  const background = [...integration.children].slice(0, 10);
  const arms = [...integration.querySelectorAll('.bg-integration-arm')].map(node => ({
    gate: Number(node.dataset.arm), node, lanes: fragmentSlot(node, null, [...node.childNodes]),
  }));
  const integrationChildren = [...integration.children], hit = integrationChildren.at(-1);
  const lastArm = integrationChildren.indexOf(arms.at(-1).node);
  const stem = fragmentSlot(integration, hit, integrationChildren.slice(lastArm + 1, -1));
  const highlights = drawing.querySelector('.bodygraph-integration-highlights');
  const focusHalos = [...highlights.querySelectorAll('.bg-integration-focus')];
  let selectionHalo = highlights.querySelector('.bg-integration-selection');
  const focus = integrationChannels.map((channel, index) => ({ channel,
    target: byType('channel', channel.id), halo: focusHalos[index] }));
  const defs = root.querySelector('defs');
  let maskKey = null, previous = null;
  function patchMask(markup, id, before = null) {
    const current = [...defs.children].find(node => node.id === id);
    if (!markup) { current?.remove(); return; }
    const start = markup.indexOf('>') + 1, end = markup.lastIndexOf('</mask>');
    if (current) current.innerHTML = markup.slice(start, end);
    else for (const node of svgNodes(defs, markup)) defs.insertBefore(node, before);
  }
  function pressed(node, type, id, fallback, state, options) {
    if (!state.interactive) return;
    const value = options.previewSelection || options.selections
      ? state.committedSelections.some(value => type === value.type
        && String(id) === String(type === 'channel' ? getChannel(value.id)?.id : value.id)) : fallback;
    setAttribute(node, 'aria-pressed', Boolean(value));
  }
  return {
    update(state, options = {}) {
      const key = coreKey(state, options);
      if (key === previous) return false;
      previous = key;
      const { personality, design, definedChannels, relatedChannels, relatedGates, halfGates,
        selectedChannels, selectedGates, definition, prefix } = state;
      for (const item of channels) {
        const { channel, node, halo } = item, selected = selectedChannels.has(channel.id);
        const related = relatedChannels.has(channel.id);
        const active = channel.gates.some(gate => personality.has(gate) || design.has(gate));
        setAttributes(node, { 'data-defined': definedChannels.has(channel.id), 'data-related': related,
          opacity: options.dimInactive && !active && !related ? .2 : 1 });
        pressed(node, 'channel', channel.id, selected, state, options);
        setAttribute(halo, 'opacity', selected ? 1 : 0);
        item.highlight(selected ? '' : channelHalves.get(channel.id).map((points, index) => halfGates.has(channel.gates[index])
          ? `<g data-highlight-gate="${channel.gates[index]}">${stroke(points, PALETTE.halo, CHANNEL_WIDTH.halo)}</g>` : '').join(''));
        item.lanes(channelHalves.get(channel.id).map((points, index) => paintActivation(points,
          personality.has(channel.gates[index]), design.has(channel.gates[index]))).join(''));
      }
      for (const { center, node, shape, halo } of centers) {
        const defined = definition.centers.has(center.id), selected = selectedCenter(center, state);
        setAttributes(node, { 'data-defined': defined, opacity: options.dimInactive && !defined && !selected ? .45 : 1 });
        if (state.interactive) setAttribute(node, 'aria-label', `${center.name} центр, ${defined ? 'определён' : 'не определён'}`);
        pressed(node, 'center', center.id, selected, state, options);
        setAttributes(shape, { fill: defined ? PALETTE[center.id] : PALETTE.paper, stroke: defined ? '#84715b' : '#b4b0a7' });
        setAttribute(halo, 'opacity', selected ? 1 : 0);
      }
      for (const { gate, node, disc, halo, text } of gates) {
        const black = personality.has(gate.id), red = design.has(gate.id), active = black || red;
        const selected = selectedGates.has(gate.id), related = relatedGates.has(gate.id);
        const fill = black && red ? `url(#${prefix}-dual)` : black ? PALETTE.ink : red ? PALETTE.design : PALETTE.paper;
        const source = black && red ? 'личность и дизайн' : black ? 'личность' : red ? 'дизайн' : 'не активированы';
        setAttributes(node, { 'data-active': active, 'data-related': related,
          opacity: options.dimInactive && !active && !selected && !related ? .3 : 1 });
        if (state.interactive) setAttribute(node, 'aria-label', `Ворота ${gate.id}: ${gate.name}, ${source}`);
        pressed(node, 'gate', gate.id, selected, state, options);
        setAttributes(disc, { fill: active ? fill : 'transparent', stroke: active ? fill.startsWith('url') ? PALETTE.ink : fill : 'none' });
        setAttributes(halo, { 'data-state': selected ? 'selected' : related ? 'related' : 'idle',
          fill: active ? 'none' : PALETTE.halo, opacity: selected || related ? 1 : 0 });
        setAttributes(text, { 'font-weight': active ? '650' : '500', fill: active ? '#ffffff' : '#171513' });
      }
      const paint = integrationPaint(state, options);
      const { integrationSelected, highlightedArms, integrationArmState, crossesStem, stemHighlighted,
        connectedIntegrationGates, activeIntegrationParts, stemOpacity, selectionPath, integrationFocusOpacity } = paint;
      setAttribute(integration, 'data-visual-selected', integrationSelected);
      pressed(integration, 'integration', 'integration', integrationSelected, state, options);
      [...integrationArmState, { opacity: stemOpacity }].forEach((part, index) => {
        setAttribute(background[index], 'opacity', part.opacity);
        setAttribute(background[index + 5], 'opacity', part.opacity);
      });
      for (const arm of arms) {
        const part = integrationArmState.find(part => part.gate === arm.gate);
        setAttributes(arm.node, { 'data-related': part.highlighted, opacity: part.opacity });
        arm.lanes(paintActivation(armPaintPoints.get(arm.gate), part.black, part.red));
      }
      stem(crossesStem ? stemHalves.map((points, index) => {
        const gates = index ? [34, 57] : [20, 10];
        return paintActivation(points, gates.some(gate => personality.has(gate)), gates.some(gate => design.has(gate)));
      }).join('') : '');
      if (selectionPath) {
        if (!selectionHalo) {
          selectionHalo = root.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'path');
          setAttributes(selectionHalo, { class: 'bg-integration-selection', fill: 'none', stroke: PALETTE.halo,
            'stroke-width': CHANNEL_WIDTH.halo, 'stroke-linejoin': 'round', 'pointer-events': 'none' });
          highlights.insertBefore(selectionHalo, focusHalos[0]);
        }
        setAttributes(selectionHalo, { d: selectionPath, 'stroke-linecap': integrationSelected ? 'butt' : 'round',
          mask: `url(#${prefix}-${integrationSelected ? 'integration-outline' : 'integration-selection-outline'})` });
      } else { selectionHalo?.remove(); selectionHalo = null; }
      for (const { channel, target, halo } of focus) {
        setAttributes(target, { 'data-defined': definedChannels.has(channel.id), 'data-related': relatedChannels.has(channel.id), opacity: integrationFocusOpacity(channel) });
        pressed(target, 'channel', channel.id, selectedChannels.has(channel.id), state, options);
        setAttribute(halo, 'style', `--integration-focus-opacity:${integrationFocusOpacity(channel)}`);
      }
      const nextMaskKey = JSON.stringify([selectionPath, integrationSelected, [...highlightedArms], stemHighlighted, connectedIntegrationGates, activeIntegrationParts]);
      if (nextMaskKey !== maskKey) {
        maskKey = nextMaskKey;
        const id = `${prefix}-integration-selection-outline`;
        patchMask(selectionPath && !integrationSelected
          ? integrationOutlineMask(id, [...highlightedArms], stemHighlighted, prefix, connectedIntegrationGates, activeIntegrationParts) : '', id,
          [...defs.children].find(node => node.id === `${prefix}-integration-focus-${integrationChannels[0].id}`));
        for (const channel of integrationChannels) {
          const id = `${prefix}-integration-focus-${channel.id}`;
          patchMask(integrationOutlineMask(id, channel.gates,
            [20, 10].includes(channel.gates[0]) !== [20, 10].includes(channel.gates[1]), prefix, channel.gates, activeIntegrationParts), id);
        }
      }
      return true;
    },
  };
}
