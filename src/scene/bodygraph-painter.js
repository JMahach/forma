import { CENTERS, GATES } from './geometry/chart-geometry.js';
import { INTEGRATION_IDS } from '../domain/topology.js';
import { paintOrder } from './geometry/drawing-geometry.js';
import { PALETTE, CHANNEL_WIDTH, paintActivation, integrationPaint, integrationStemPaint, channelPaint, centerPaint, gatePaint,
  integrationOutlineMask, integrationChannels, armPaintPoints } from './bodygraph-paint.js';
import { isSelectionPressed } from './render-state.js';
import { setAttribute, setAttributes, fragmentSlot, svgNodes } from './svg-patches.js';

const coreKey = (state, options) => [state.personality, state.design, state.relatedChannels,
  state.relatedGates, state.halfGates, state.selectedGates, state.selectedCenters,
  state.selectedChannels].map(set => [...set].join(',')).join('|')
  + JSON.stringify([state.committedSelections, state.visualSelections.some(v => v.type === 'integration'),
    Boolean(options.previewSelection || options.selections), options.dimInactive]);

// Targets never change identity when a minute, activation or selection changes.
// Only a channel's variable lanes and the small integration masks are fragments.
export function createBodygraphPainter(root, initialState = null, initialOptions = {}) {
  const initialIntegration = initialState ? integrationPaint(initialState, initialOptions) : null;
  const drawing = root.querySelector('.bodygraph-drawing');
  const byType = (type, id) => drawing.querySelector(`.bodygraph-${type === 'gate' ? 'gates' : type === 'center' ? 'centers' : 'channels'} [data-type="${type}"][data-id="${id}"]`);
  const channels = paintOrder.filter(channel => !INTEGRATION_IDS.has(channel.id)).map(channel => {
    const node = byType('channel', channel.id);
    const halo = node.querySelector('.bg-channel-highlight');
    const outline = node.querySelector('.bg-channel-outline');
    const hit = node.querySelector('.bg-focus-shape');
    const children = [...node.children], paper = children[children.indexOf(outline) + 1];
    const initialPaint = initialState ? channelPaint(channel, initialState, initialOptions) : null;
    return { channel, node, halo,
      highlight: fragmentSlot(node, halo, children.slice(0, children.indexOf(halo)), initialPaint?.highlight),
      lanes: fragmentSlot(node, hit, children.slice(children.indexOf(paper) + 1, children.indexOf(hit)), initialPaint?.lanes) };
  });
  const centers = CENTERS.map(center => { const node = byType('center', center.id); return { center, node,
    shape: node.querySelector('.bg-center-shape'), halo: node.querySelector('.bg-center-highlight') }; });
  const gates = GATES.flatMap(gate => { const node = byType('gate', gate.id); return node ? [{ gate, node,
    disc: node.querySelector('.bg-gate-disc'), halo: node.querySelector('.bg-gate-highlight'), text: node.querySelector('text') }] : []; });
  const integration = byType('integration', 'integration');
  const background = [...integration.children].slice(0, 10);
  const arms = [...integration.querySelectorAll('.bg-integration-arm')].map(node => ({
    gate: Number(node.dataset.arm), node, lanes: fragmentSlot(node, null, [...node.childNodes],
      initialState ? paintActivation(armPaintPoints.get(Number(node.dataset.arm)),
        initialState.personality.has(Number(node.dataset.arm)), initialState.design.has(Number(node.dataset.arm))) : undefined),
  }));
  const integrationChildren = [...integration.children], hit = integrationChildren.at(-1);
  const lastArm = integrationChildren.indexOf(arms.at(-1).node);
  const stem = fragmentSlot(integration, hit, integrationChildren.slice(lastArm + 1, -1),
    initialState ? integrationStemPaint(initialState, initialIntegration) : undefined);
  const highlights = drawing.querySelector('.bodygraph-integration-highlights');
  const focusHalos = [...highlights.querySelectorAll('.bg-integration-focus')];
  let selectionHalo = highlights.querySelector('.bg-integration-selection');
  const focus = integrationChannels.map((channel, index) => ({ channel,
    target: byType('channel', channel.id), halo: focusHalos[index] }));
  const defs = root.querySelector('defs');
  const maskSignature = paint => JSON.stringify([paint.selectionPath, paint.integrationSelected,
    [...paint.highlightedArms], paint.stemHighlighted, paint.connectedIntegrationGates, paint.activeIntegrationParts]);
  let maskKey = initialIntegration ? maskSignature(initialIntegration) : null;
  let previous = initialState ? coreKey(initialState, initialOptions) : null;
  function patchMask(markup, id, before = null) {
    const current = [...defs.children].find(node => node.id === id);
    if (!markup) { current?.remove(); return; }
    const start = markup.indexOf('>') + 1, end = markup.lastIndexOf('</mask>');
    if (current) current.innerHTML = markup.slice(start, end);
    else for (const node of svgNodes(defs, markup)) defs.insertBefore(node, before);
  }
  function pressed(node, type, id, fallback, state) {
    if (state.interactive) setAttribute(node, 'aria-pressed', Boolean(isSelectionPressed(state, type, id, fallback)));
  }
  return {
    update(state, options = {}) {
      const key = coreKey(state, options);
      if (key === previous) return false;
      previous = key;
      const { definedChannels, relatedChannels, selectedChannels, prefix } = state;
      for (const item of channels) {
        const { channel, node, halo } = item, paint = channelPaint(channel, state, options);
        setAttributes(node, { 'data-defined': paint.defined, 'data-related': paint.related, opacity: paint.opacity });
        pressed(node, 'channel', channel.id, paint.selected, state);
        setAttribute(halo, 'opacity', paint.selected ? 1 : 0);
        item.highlight(paint.highlight);
        item.lanes(paint.lanes);
      }
      for (const { center, node, shape, halo } of centers) {
        const paint = centerPaint(center, state, options);
        setAttributes(node, { 'data-defined': paint.defined, opacity: paint.opacity });
        if (state.interactive) setAttribute(node, 'aria-label', paint.label);
        pressed(node, 'center', center.id, paint.selected, state);
        setAttributes(shape, { fill: paint.fill, stroke: paint.stroke });
        setAttribute(halo, 'opacity', paint.selected ? 1 : 0);
      }
      for (const { gate, node, disc, halo, text } of gates) {
        const paint = gatePaint(gate, state, options);
        setAttributes(node, { 'data-active': paint.active, 'data-related': paint.related, opacity: paint.opacity });
        if (state.interactive) setAttribute(node, 'aria-label', paint.label);
        pressed(node, 'gate', gate.id, paint.selected, state);
        setAttributes(disc, { fill: paint.fill, stroke: paint.stroke });
        setAttributes(halo, { 'data-state': paint.highlightState, fill: paint.highlightFill, opacity: paint.highlightOpacity });
        setAttributes(text, { 'font-weight': paint.textWeight, fill: paint.textFill });
      }
      const paint = integrationPaint(state, options);
      const { integrationSelected, highlightedArms, integrationArmState, stemHighlighted,
        connectedIntegrationGates, activeIntegrationParts, stemOpacity, selectionPath, integrationFocusOpacity } = paint;
      setAttribute(integration, 'data-visual-selected', integrationSelected);
      pressed(integration, 'integration', 'integration', integrationSelected, state);
      [...integrationArmState, { opacity: stemOpacity }].forEach((part, index) => {
        setAttribute(background[index], 'opacity', part.opacity);
        setAttribute(background[index + 5], 'opacity', part.opacity);
      });
      for (const arm of arms) {
        const part = integrationArmState.find(part => part.gate === arm.gate);
        setAttributes(arm.node, { 'data-related': part.highlighted, opacity: part.opacity });
        arm.lanes(paintActivation(armPaintPoints.get(arm.gate), part.black, part.red));
      }
      stem(integrationStemPaint(state, paint));
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
        pressed(target, 'channel', channel.id, selectedChannels.has(channel.id), state);
        setAttribute(halo, 'style', `--integration-focus-opacity:${integrationFocusOpacity(channel)}`);
      }
      const nextMaskKey = maskSignature(paint);
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
