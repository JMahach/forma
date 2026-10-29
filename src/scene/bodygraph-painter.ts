import { paintIntegrationLayers } from './integration-paint.ts';
import { canSoften, softHighlightFragment, observeSoftHighlightMotion, SOFT_HIGHLIGHT_DURATION } from './soft-highlight.ts';
import type { RenderState, RenderOptions } from './render-state.ts';
import type { SelectionType } from '../selection/selection-targets.ts';
import { CENTERS, GATES } from './geometry/chart-geometry.ts';
import { INTEGRATION_IDS } from '../domain/topology.ts';
import { paintOrder } from './geometry/drawing-geometry.ts';
import { channelHighlightWidth } from './geometry/drawing-presentation.ts';
import { PALETTE, activationLaneColor, integrationPaint, integrationHighlightPaint, channelPaint, channelLanes, centerPaint, gatePaint,
  integrationOutlineMask, integrationChannels } from './bodygraph-paint.ts';
import { isSelectionPressed } from './render-state.ts';
import { setAttribute, setAttributes, fragmentSlot, svgNodes } from './svg-patches.ts';

const physicalKey = (state: RenderState) => JSON.stringify([[...state.personality], [...state.design],
  state.overlaySources ? [state.overlaySources.kind, state.overlaySources.sources.map(source => source.label), [...state.overlaySources.masks]] : null]);

const coreKey = (state: RenderState, options: RenderOptions) => [state.personality, state.design, state.relatedChannels,
  state.relatedGates, state.halfGates, state.selectedGates, state.selectedCenters,
  state.selectedChannels].map(set => [...set].join(',')).join('|')
  + JSON.stringify([state.committedSelections, state.visualSelections.some(v => v.type === 'integration'),
    Boolean(options.previewSelection || options.selections), options.dimInactive,
    state.overlaySources ? [state.overlaySources.kind, state.overlaySources.sources.map(source => source.label),
      [...state.overlaySources.masks].sort((a, b) => a[0] - b[0])] : null]);

// Targets never change identity when a minute, activation or selection changes.
// Only a channel's variable lanes and the small integration masks are fragments.
export function createBodygraphPainter(root: Element, initialState: RenderState | null = null, initialOptions: RenderOptions = {}) {
  const disposeMotion = observeSoftHighlightMotion(root);
  const initialIntegration = initialState ? integrationPaint(initialState, initialOptions) : null;
  const drawing = root.querySelector('.bodygraph-drawing')!;
  const byType = (type: SelectionType, id: string | number) => drawing.querySelector<SVGElement>(`.bodygraph-${type === 'gate' ? 'gates' : type === 'center' ? 'centers' : 'channels'} [data-type="${type}"][data-id="${id}"]`)!;
  const initialChannelColors: string[] = [];
  const channels = paintOrder.filter(channel => !INTEGRATION_IDS.has(channel.id)).map(channel => {
    const node = byType('channel', channel.id);
    const halo = node.querySelector('.bg-channel-highlight')!;
    const outline = node.querySelector('.bg-channel-outline')!;
    const hit = node.querySelector('.bg-focus-shape')!;
    const children = [...node.children], paper = children[children.indexOf(halo) + 1];
    const initialPaint = initialState ? channelPaint(channel, initialState, initialOptions) : null;
    initialChannelColors.push(initialPaint?.highlightDefinitions ?? '');
    return { channel, node, halo, colors: initialPaint?.highlightDefinitions ?? '',
      highlight: softHighlightFragment(node, halo, children.slice(children.indexOf(outline) + 1, children.indexOf(halo)), initialPaint?.highlight),
      lanes: fragmentSlot(node, hit, children.slice(children.indexOf(paper) + 1, children.indexOf(hit)), initialState ? channelLanes(channel, initialState) : undefined) };
  });
  const centers = CENTERS.map(center => { const node = byType('center', center.id); return { center, node,
    shape: node.querySelector('.bg-center-shape'), halo: node.querySelector('.bg-center-highlight') }; });
  const gates = GATES.flatMap(gate => { const node = byType('gate', gate.id); return node ? [{ gate, node,
    disc: node.querySelector('.bg-gate-disc'), glow: node.querySelector('.bg-gate-glow'), halo: node.querySelector('.bg-gate-highlight'), text: node.querySelector('text') }] : []; });
  const integration = byType('integration', 'integration');
  const background = [...drawing.querySelector('.bodygraph-integration-outlines')!.children, ...[...integration.children].slice(0, 5)];
  const colorLayer = integration.querySelector('.bodygraph-integration-paint')!;
  const paintColors = fragmentSlot(colorLayer, null, [...colorLayer.childNodes],
    initialState ? paintIntegrationLayers(initialState) : undefined);
  const highlights = drawing.querySelector('.bodygraph-integration-highlights')!;
  const glowIntegration = initialOptions.highlightStyle === 'glow';
  const effectFor = (path: Element) => glowIntegration ? path.parentElement! : path;
  function selectionEffect(path: Element) {
    if (!glowIntegration) return path;
    const effect = root.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'g');
    setAttributes(effect, { 'data-integration-effect': 'selection', filter: `url(#${initialState?.prefix ?? initialOptions.idPrefix ?? 'bodygraph'}-glow-integration)` });
    effect.appendChild(path);
    return effect;
  }
  const focusHalos = [...highlights.querySelectorAll('.bg-integration-focus')];
  let selectionHalo = highlights.querySelector('.bg-integration-selection');
  let selectionEnter: Animation | null = null;
  let outgoing: { path: Element; effect: Element; mask: Element | null; colors: Element | null; animation: Animation } | null = null;
  let soften = false;
  function retireSelection() {
    outgoing?.animation.cancel(); outgoing?.effect.remove(); outgoing?.mask?.remove(); outgoing?.colors?.remove(); outgoing = null;
    if (!selectionHalo || !soften) return;
    const path = root.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'path');
    for (const name of selectionHalo.getAttributeNames()) path.setAttribute(name, selectionHalo.getAttribute(name)!);
    const effect = selectionEffect(path);
    effect.setAttribute('data-soft-highlight-outgoing', 'paint');
    path.removeAttribute('class');
    const maskId = selectionHalo.getAttribute('mask')?.slice(5, -1);
    const sourceMask = [...defs.children].find(node => node.id === maskId);
    let mask: Element | null = null;
    if (sourceMask) {
      mask = root.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'mask');
      for (const name of sourceMask.getAttributeNames()) mask.setAttribute(name, sourceMask.getAttribute(name)!);
      mask.id = `${maskId}-outgoing`;
      mask.setAttribute('data-soft-highlight-outgoing', 'mask');
      mask.innerHTML = sourceMask.innerHTML;
      defs.appendChild(mask);
      path.setAttribute('mask', `url(#${mask.id})`);
    }
    let colors: Element | null = null;
    const stroke = selectionHalo.getAttribute('stroke');
    if (stroke?.startsWith('url(#') && colorDefs.innerHTML) {
      const colorId = stroke.slice(5, -1);
      colors = root.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'g');
      colors.setAttribute('data-soft-highlight-outgoing', 'colors');
      colors.innerHTML = colorDefs.innerHTML.replaceAll(colorId, `${colorId}-outgoing`);
      defs.appendChild(colors);
      path.setAttribute('stroke', `url(#${colorId}-outgoing)`);
    }
    const opacity = selectionEnter ? root.ownerDocument.defaultView!.getComputedStyle(effectFor(selectionHalo)).opacity : '1';
    highlights.insertBefore(effect, effectFor(selectionHalo));
    const animation = effect.animate([{ opacity }, { opacity: '0' }], { duration: SOFT_HIGHLIGHT_DURATION.exit, easing: 'ease-out' });
    const retired = { path, effect, mask, colors, animation };
    outgoing = retired;
    animation.onfinish = () => { effect.remove(); mask?.remove(); colors?.remove(); animation.cancel(); if (outgoing === retired) outgoing = null; };
  }
  const focus = integrationChannels.map((channel, index) => ({ channel,
    target: byType('channel', channel.id), halo: focusHalos[index] }));
  const defs = root.querySelector('defs')!;
  const channelColorDefs = defs.querySelector('.bg-channel-color-defs')!;
  const paintChannelColors = fragmentSlot(channelColorDefs, null, [...channelColorDefs.childNodes], initialState ? initialChannelColors.join('') : undefined);
  const colorDefs = defs.querySelector('.bg-integration-color-defs')!;
  const paintHighlightColors = fragmentSlot(colorDefs, null, [...colorDefs.childNodes],
    initialState ? integrationHighlightPaint(initialState, initialOptions, initialIntegration!).definitions : undefined);
  const dualStops = [...defs.querySelector('linearGradient')!.querySelectorAll('stop')];
  const selectionMaskSignature = (paint: ReturnType<typeof integrationPaint>) => JSON.stringify([paint.selectionPath, paint.integrationSelected,
    [...paint.highlightedArms], paint.stemHighlighted, paint.connectedIntegrationGates, paint.activeIntegrationParts]);
  const focusMaskSignature = (paint: ReturnType<typeof integrationPaint>) => JSON.stringify(paint.activeIntegrationParts);
  let selectionMaskKey = initialIntegration ? selectionMaskSignature(initialIntegration) : null;
  let focusMaskKey = initialIntegration ? focusMaskSignature(initialIntegration) : null;
  let paintedState = initialState, paintedDim = initialOptions.dimInactive;
  let previousPhysical = initialState ? physicalKey(initialState) : null;
  let previous = initialState ? coreKey(initialState, initialOptions) : null;
  function patchMask(markup: string, id: string, before: Node | null = null) {
    const current = [...defs.children].find(node => node.id === id);
    if (!markup) { current?.remove(); return; }
    const start = markup.indexOf('>') + 1, end = markup.lastIndexOf('</mask>');
    if (current) current.innerHTML = markup.slice(start, end);
    else for (const node of svgNodes(defs, markup)) defs.insertBefore(node, before);
  }
  function pressed(node: Element, type: SelectionType, id: string | number, fallback: boolean, state: RenderState) {
    if (state.interactive) setAttribute(node, 'aria-pressed', Boolean(isSelectionPressed(state, type, id, fallback)));
  }
  return {
    dispose: disposeMotion,
    update(state: RenderState, options: RenderOptions = {}) {
      const key = coreKey(state, options);
      if (key === previous) return false;
      previous = key;
      const physical = physicalKey(state), physicalChanged = physical !== previousPhysical;
      const prior = paintedState, dimChanged = paintedDim !== options.dimInactive;
      paintedState = state; paintedDim = options.dimInactive;
      previousPhysical = physical;
      soften = canSoften(root);
      const channelColors: string[] = [];
      dualStops.forEach((stop, lane) => setAttribute(stop, 'stop-color', activationLaneColor(state, lane)));
      const { definedChannels, relatedChannels, selectedChannels, prefix } = state;
      for (const item of channels) {
        const { channel, node, halo } = item;
        if (!physicalChanged && !dimChanged && prior
          && prior.selectedChannels.has(channel.id) === state.selectedChannels.has(channel.id)
          && prior.relatedChannels.has(channel.id) === state.relatedChannels.has(channel.id)
          && prior.committedIdsByType.get('channel')?.has(channel.id) === state.committedIdsByType.get('channel')?.has(channel.id)
          && isSelectionPressed(prior, 'channel', channel.id, prior.selectedChannels.has(channel.id))
            === isSelectionPressed(state, 'channel', channel.id, state.selectedChannels.has(channel.id))
          && channel.gates.every(gate => prior.halfGates.has(gate) === state.halfGates.has(gate)
            && prior.committedGates.has(gate) === state.committedGates.has(gate))) {
          channelColors.push(item.colors); continue;
        }
        const paint = channelPaint(channel, state, options);
        setAttributes(node, { 'data-defined': paint.defined, 'data-related': paint.related, opacity: paint.opacity });
        pressed(node, 'channel', channel.id, paint.selected, state);
        setAttribute(halo, 'stroke', paint.highlightColor);
        setAttribute(halo, 'opacity', paint.selected ? 1 : 0);
        item.highlight(paint.highlight, soften);
        if (physicalChanged) item.lanes(channelLanes(channel, state));
        item.colors = paint.highlightDefinitions;
        channelColors.push(item.colors);
      }
      paintChannelColors(channelColors.join(''));
      for (const { center, node, shape, halo } of centers) {
        const paint = centerPaint(center, state, options);
        setAttributes(node, { 'data-defined': paint.defined, opacity: paint.opacity });
        if (state.interactive) setAttribute(node, 'aria-label', paint.label);
        pressed(node, 'center', center.id, paint.selected, state);
        setAttributes(shape, { fill: paint.fill, stroke: paint.stroke });
        setAttribute(halo, 'stroke', paint.highlightColor);
        setAttribute(halo, 'opacity', paint.selected ? 1 : 0);
      }
      for (const { gate, node, disc, glow, halo, text } of gates) {
        if (!physicalChanged && !dimChanged && prior
          && prior.selectedGates.has(gate.id) === state.selectedGates.has(gate.id)
          && prior.relatedGates.has(gate.id) === state.relatedGates.has(gate.id)
          && prior.committedGates.has(gate.id) === state.committedGates.has(gate.id)
          && isSelectionPressed(prior, 'gate', gate.id, prior.selectedGates.has(gate.id))
            === isSelectionPressed(state, 'gate', gate.id, state.selectedGates.has(gate.id))) continue;
        const paint = gatePaint(gate, state, options);
        setAttributes(node, { 'data-active': paint.active, 'data-related': paint.related, opacity: paint.opacity });
        if (state.interactive) setAttribute(node, 'aria-label', paint.label);
        pressed(node, 'gate', gate.id, paint.selected, state);
        setAttributes(disc, { fill: paint.fill, stroke: paint.stroke });
        if (options.highlightStyle === 'glow') setAttributes(glow, { fill: paint.highlightColor, mask: paint.glowMask! });
        else setAttribute(glow, 'stroke', paint.highlightColor);
        if (options.highlightStyle === 'glow') setAttribute(halo, 'stroke', paint.highlightColor);
        setAttribute(glow, 'opacity', paint.highlightOpacity);
        setAttributes(halo, { 'data-state': paint.highlightState, fill: paint.highlightFill });
        setAttribute(halo, 'opacity', paint.highlightOpacity);
        setAttributes(text, { 'font-weight': paint.textWeight, fill: paint.textFill });
      }
      const paint = integrationPaint(state, options);
      const integrationHighlight = integrationHighlightPaint(state, options, paint);
      setAttribute(highlights.querySelector('.bg-integration-hover'), 'stroke', integrationHighlight.color);
      for (const halo of focusHalos) setAttribute(halo, 'stroke', integrationHighlight.color);
      const { integrationSelected, highlightedArms, integrationArmState, stemHighlighted,
        connectedIntegrationGates, activeIntegrationParts, stemOpacity, selectionPath, integrationFocusOpacity } = paint;
      setAttribute(integration, 'data-visual-selected', integrationSelected);
      pressed(integration, 'integration', 'integration', integrationSelected, state);
      [...integrationArmState, { opacity: stemOpacity }].forEach((part, index) => {
        setAttribute(background[index], 'opacity', part.opacity);
        setAttribute(background[index + 5], 'opacity', part.opacity);
      });
      if (physicalChanged) paintColors(paintIntegrationLayers(state));
      const selectionChanged = selectionHalo?.getAttribute('d') !== selectionPath
        || selectionHalo?.getAttribute('mask') !== `url(#${prefix}-${integrationSelected ? 'integration-outline' : 'integration-selection-outline'})`;
      let reclaimedOpacity: string | undefined;
      if (selectionChanged) {
        if (!selectionHalo && outgoing && outgoing.path.getAttribute('d') === selectionPath && soften) {
          reclaimedOpacity = root.ownerDocument.defaultView!.getComputedStyle(outgoing.effect).opacity;
          outgoing.animation.cancel(); outgoing.mask?.remove(); outgoing.colors?.remove();
          selectionHalo = outgoing.path;
          selectionHalo.setAttribute('class', 'bg-integration-selection');
          outgoing.effect.removeAttribute('data-soft-highlight-outgoing');
          highlights.insertBefore(outgoing.effect, effectFor(focusHalos[0]));
          outgoing = null;
        } else retireSelection();
        selectionEnter?.cancel(); selectionEnter = null;
      }
      paintHighlightColors(integrationHighlight.definitions);
      const enteringSelection = !selectionHalo;
      if (selectionPath) {
        if (!selectionHalo) {
          selectionHalo = root.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'path');
          setAttributes(selectionHalo, { class: 'bg-integration-selection', fill: 'none', stroke: PALETTE.halo,
            'stroke-width': channelHighlightWidth(options.highlightStyle), 'stroke-linejoin': 'round', 'pointer-events': 'none' });
          highlights.insertBefore(selectionEffect(selectionHalo), effectFor(focusHalos[0]));
        }
        setAttributes(selectionHalo, { d: selectionPath, stroke: integrationHighlight.selectionColor, 'stroke-linecap': integrationSelected ? 'butt' : 'round',
          mask: `url(#${prefix}-${integrationSelected ? 'integration-outline' : 'integration-selection-outline'})` });
        // A geometry change cross-fades its previous masked paint; fixed half halos
        // elsewhere retain identity and never restart when their gate stays lit.
        if (selectionChanged && soften) {
          const animation = effectFor(selectionHalo).animate([{ opacity: reclaimedOpacity ?? (enteringSelection || outgoing ? '0' : root.ownerDocument.defaultView!.getComputedStyle(effectFor(selectionHalo)).opacity) }, { opacity: '1' }], { duration: SOFT_HIGHLIGHT_DURATION.enter, easing: 'ease-out' });
          selectionEnter = animation;
          animation.onfinish = () => { if (selectionEnter === animation) selectionEnter = null; animation.cancel(); };
        }
      } else { if (selectionHalo) effectFor(selectionHalo).remove(); selectionHalo = null; }
      for (const { channel, target, halo } of focus) {
        setAttributes(target, { 'data-defined': definedChannels.has(channel.id), 'data-related': relatedChannels.has(channel.id), opacity: integrationFocusOpacity(channel) });
        pressed(target, 'channel', channel.id, selectedChannels.has(channel.id), state);
        setAttribute(effectFor(halo), 'style', `--integration-focus-opacity:${integrationFocusOpacity(channel)}`);
      }
      const nextSelectionMaskKey = selectionMaskSignature(paint);
      if (nextSelectionMaskKey !== selectionMaskKey) {
        selectionMaskKey = nextSelectionMaskKey;
        const id = `${prefix}-integration-selection-outline`;
        patchMask(selectionPath && !integrationSelected
          ? integrationOutlineMask(id, [...highlightedArms], stemHighlighted, prefix, connectedIntegrationGates, activeIntegrationParts, options.highlightStyle) : '', id,
          [...defs.children].find(node => node.id === `${prefix}-integration-focus-${integrationChannels[0].id}`)!);
      }
      // Focus routes are fixed. Only active arms/stem change their occlusion;
      // hovering or selecting a different route cannot change these masks.
      const nextFocusMaskKey = focusMaskSignature(paint);
      if (nextFocusMaskKey !== focusMaskKey) {
        focusMaskKey = nextFocusMaskKey;
        for (const channel of integrationChannels) {
          const id = `${prefix}-integration-focus-${channel.id}`;
          patchMask(integrationOutlineMask(id, channel.gates,
            [20, 10].includes(channel.gates[0]) !== [20, 10].includes(channel.gates[1]), prefix, channel.gates, activeIntegrationParts, options.highlightStyle), id);
        }
      }
      return true;
    },
  };
}
