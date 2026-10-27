import type { ChartRecord } from '../../shared/chart-types.ts';
import type { CycleEvent } from '../../shared/cycles-format.ts';
import type { TimelinePointer, TimelineGeometry, TimelineTarget } from './timeline-range.ts';
type MarkerUtc = string | number | null | undefined;
interface ReturnMarkerGroup { events: CycleEvent[]; position: number; labelLane?: 'below' | 'above'; labelHidden?: boolean; labelOffset?: number }
interface MarkerInputs { events?: readonly CycleEvent[] | null; natal?: Partial<ChartRecord> | null; fromUtc?: MarkerUtc; toUtc?: MarkerUtc; displayedUtc?: MarkerUtc; visible?: boolean }
interface MarkerLayout {
  visible: boolean; fromUtc: MarkerUtc; toUtc: MarkerUtc;
  natalId: ChartRecord['id'] | undefined; natalUtc: ChartRecord['utc']; natalTimezone: ChartRecord['timezone'];
  events: Pick<CycleEvent, 'id' | 'body' | 'utc' | 'cycle' | 'cycleId' | 'pass' | 'direction'>[];
}
interface ReturnMarkerNode {
  button: HTMLButtonElement; dot: HTMLElement; symbol: HTMLElement; glyph: HTMLElement; ordinal: HTMLElement;
  event: CycleEvent; utc: number; hover: (active: boolean) => void; press: (active: boolean) => void;
}
interface ReturnMarkerOptions { container: HTMLElement; onSelect?: (event: CycleEvent) => void; onTargetsChange?: () => void }
export type ReturnMarkers = ReturnType<typeof attachReturnMarkers>;

import { CYCLE_BODIES, cycleEventLabel, cycleTimeZone } from '../domain/cycles.ts';
import { isReferenceMoment } from './timeline-range.ts';
import { ageText, completedAge } from '../domain/personal-age.ts';
import { TIMELINE_THUMB_SIZE } from '../ui/layout/metrics.ts';

const SYMBOLS = Object.fromEntries(CYCLE_BODIES.map(body => [body.id, body.symbol]));
const BODIES = new Set(CYCLE_BODIES.map(body => body.id));
const milliseconds = (value: MarkerUtc) => typeof value === 'number' ? value : Date.parse(value!);

// Each independent lifecycle owns a node at its first exact passage. Pixel
// proximity may arrange labels, but must never remove a different cycle.
export function groupReturnMarkers(events: readonly CycleEvent[] | null | undefined, { fromUtc, toUtc, width }: { fromUtc?: MarkerUtc; toUtc?: MarkerUtc; width?: number | null } = {}, separation = 20) {
  const from = milliseconds(fromUtc), to = milliseconds(toUtc);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return [];
  const pixels = Number.isFinite(width) ? Math.max(0, width!) : 0;
  const distance = Number.isFinite(separation) ? Math.max(0, separation) : 20;
  const points = (Array.isArray(events) ? events : []).filter(event => BODIES.has(event?.body)
    && typeof event.id === 'string' && Number.isFinite(Date.parse(event.utc))
    && Date.parse(event.utc) >= from && Date.parse(event.utc) <= to)
    .map(event => ({ event, utc: Date.parse(event.utc) })).sort((a, b) => a.utc - b.utc);
  const groups: ReturnMarkerGroup[] = [], cycles = new Map<string, ReturnMarkerGroup>();
  for (const point of points) {
    const cycle = Number.isInteger(point.event.cycle) && point.event.cycle > 0 ? point.event.cycle : point.event.cycleId || point.event.id;
    const key = `${point.event.body}:${cycle}`;
    if (cycles.has(key)) cycles.get(key)!.events.push(point.event);
    // A clipped range may contain only pass 2/3. They cannot replace the
    // cycle's first exact touch; later passes only join its existing marker.
    else if (point.event.pass === 1) {
      const group = { events: [point.event], position: to === from ? .5 : (point.utc - from) / (to - from) };
      cycles.set(key, group); groups.push(group);
    }
  }
  // Labels get only the space they can occupy. Dense events retain their
  // exact nodes and accessible names, without pushing text beyond the rail.
  const last = [-Infinity, -Infinity];
  for (const group of groups) {
    const x = group.position * pixels;
    const digits = group.events[0].body === 'uranus_opposition' ? 0 : String(group.events[0].cycle || '').length;
    const half = Math.max(10, (14 + ((SYMBOLS[group.events[0].body]?.length || 1) - 1 + digits) * 7) / 2);
    const center = Math.max(half, Math.min(pixels - half, x));
    const gap = Math.max(distance, half * 2 + 3);
    // Prefer the lower row; its whole label must clear the endpoint captions.
    const belowFits = center - half >= 48 && center + half <= pixels - 48 && center - last[1] >= gap;
    const lane = belowFits ? 1 : 0;
    const placed = Math.max(center, last[lane] + gap);
    group.labelLane = lane ? 'below' : 'above';
    group.labelHidden = pixels > 0 && (placed > pixels - half || Math.abs(placed - x) > gap);
    group.labelOffset = pixels && !group.labelHidden ? placed - x : 0;
    if (!group.labelHidden) last[lane] = placed;
  }
  return groups;
}

function labelsFor(natal: Partial<ChartRecord> | null | undefined) {
  const timeZone = cycleTimeZone(natal?.timezone);
  const options: Intl.DateTimeFormatOptions = { year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' };
  const format = new Intl.DateTimeFormat('ru-RU', { ...options, timeZone });
  return (event: CycleEvent) => {
    const age = completedAge(event.utc, natal);
    const ageLabel = age === null ? '' : ageText(age);
    const direction = { direct: 'прямой ход', retrograde: 'ретроградный ход', stationary: 'стационарный момент' }[event.direction];
    return [[cycleEventLabel(event), ageLabel].filter(Boolean).join(' · '),
      format.format(new Date(event.utc)),
      [timeZone, direction].filter(Boolean).join(' · ')].join('\n');
  };
}

// This layer shares the slider's 22 px rail endpoints. Pointer input passes
// through to the range, which resolves a roomy event tap or a continuous drag.
export function attachReturnMarkers({ container, onSelect = () => {}, onTargetsChange = () => {} }: ReturnMarkerOptions) {
  const document = container.ownerDocument;
  const layer = document.createElement('div');
  layer.className = 'returns-markers'; layer.hidden = true; container.append(layer);
  let inputs: (MarkerInputs & { events: readonly CycleEvent[] }) | null = null, layout: MarkerLayout | null = null, width: number | null = null, labelKey: string | null = null;
  let label: ReturnType<typeof labelsFor> | null = null, targets: ReturnMarkerNode[] = [], hovered: HTMLButtonElement | null = null;
  let hitMetrics: TimelineGeometry | null | undefined = null, hitBoxes: { target: ReturnMarkerNode; rect: DOMRect }[] | null = null;
  const records = new Map<string, ReturnMarkerNode>();
  function hover(button: HTMLButtonElement | null) {
    if (hovered === button) return;
    if (hovered) delete hovered.dataset.hovered;
    hovered = button;
    if (hovered) hovered.dataset.hovered = 'true';
  }
  function node<K extends keyof HTMLElementTagNameMap>(tag: K, className: string) {
    const element = document.createElement(tag); element.className = className;
    return element;
  }
  function updateActive() {
    const displayed = milliseconds(inputs!.displayedUtc);
    for (const target of targets) {
      const active = String(isReferenceMoment(displayed, target.utc));
      if (target.button.getAttribute('aria-pressed') !== active) target.button.setAttribute('aria-pressed', active);
    }
  }
  function render() {
    hitMetrics = null; hitBoxes = null;
    const { events, natal, fromUtc, toUtc, visible } = inputs!;
    if (visible && width === null) width = Math.max(0, container.getBoundingClientRect().width - TIMELINE_THUMB_SIZE);
    const groups = visible ? groupReturnMarkers(events, { fromUtc, toUtc, width }) : [];
    const nextLabelKey = JSON.stringify([natal?.utc, natal?.timezone]);
    if (groups.length && nextLabelKey !== labelKey) { label = labelsFor(natal); labelKey = nextLabelKey; }
    const ids = new Set(groups.map(group => group.events[0].id));
    for (const [id, target] of records) if (!ids.has(id)) {
      if (hovered === target.button) hover(null);
      target.button.remove(); records.delete(id);
    }
    layer.hidden = !groups.length;
    targets = groups.map((group, index) => {
      const event = group.events[0];
      let target = records.get(event.id);
      if (!target) {
        const button = node('button', 'returns-marker'); button.type = 'button';
        const dot = node('span', 'returns-marker-dot'); dot.setAttribute('aria-hidden', 'true');
        const symbol = node('span', 'returns-marker-symbol'); symbol.setAttribute('aria-hidden', 'true');
        const glyph = node('span', 'returns-marker-glyph'), ordinal = node('span', 'returns-marker-ordinal');
        symbol.append(glyph, ordinal);
        button.append(dot, symbol);
        target = { button, dot, symbol, glyph, ordinal, hover: (active: boolean) => hover(active ? button : null),
          press: (active: boolean) => { if (active) button.dataset.pressed = 'true'; else delete button.dataset.pressed; } } as ReturnMarkerNode;
        button.addEventListener('click', action => { if (!action.detail) onSelect(target!.event); });
        records.set(event.id, target);
      }
      target.event = event; target.utc = Date.parse(event.utc);
      const { button, glyph, ordinal } = target;
      button.style.left = `${group.position * 100}%`;
      button.dataset.returnMarker = event.id;
      button.dataset.cycleBody = event.body;
      button.dataset.labelLane = group.labelLane!;
      button.dataset.labelHidden = String(group.labelHidden);
      button.style.setProperty('--return-label-offset', `${group.labelOffset}px`);
      const text = label!(event);
      button.title = text; button.setAttribute('aria-label', text);
      const ordinalValue = event.body !== 'uranus_opposition' && Number.isInteger(event.cycle) && event.cycle > 0 ? String(event.cycle) : '';
      glyph.textContent = SYMBOLS[event.body];
      ordinal.textContent = ordinalValue;
      ordinal.hidden = !ordinalValue;
      if (layer.children[index] !== button) layer.insertBefore(button, layer.children[index] || null);
      return target;
    });
    updateActive();
    onTargetsChange();
  }
  function update(next: MarkerInputs) {
    inputs = { ...next, events: Array.isArray(next.events) ? next.events : [] };
    // Clock changes update only changed indicators; labels and layout stay intact.
    if (sameLayout(inputs)) { updateActive(); return; }
    // Copy only fields of the shown layout. A caller may replace or mutate its
    // events; time movement must neither miss such edits nor serialize the list.
    layout = { visible: Boolean(next.visible), fromUtc: next.fromUtc, toUtc: next.toUtc,
      natalId: next.natal?.id, natalUtc: next.natal?.utc, natalTimezone: next.natal?.timezone,
      events: inputs.events.map(event => ({ id: event?.id, body: event?.body, utc: event?.utc,
        cycle: event?.cycle, cycleId: event?.cycleId, pass: event?.pass, direction: event?.direction })) };
    render();
  }
  function sameLayout(next: MarkerInputs & { events: readonly CycleEvent[] }) {
    if (!layout || Boolean(next.visible) !== layout.visible || next.fromUtc !== layout.fromUtc || next.toUtc !== layout.toUtc
      || next.natal?.id !== layout.natalId || next.natal?.utc !== layout.natalUtc || next.natal?.timezone !== layout.natalTimezone
      || next.events.length !== layout.events.length) return false;
    for (let i = 0; i < next.events.length; i++) {
      const event = next.events[i], shown = layout.events[i];
      if (event?.id !== shown?.id || event?.body !== shown?.body || event?.utc !== shown?.utc
        || event?.cycle !== shown?.cycle || event?.cycleId !== shown?.cycleId || event?.pass !== shown?.pass
        || event?.direction !== shown?.direction) return false;
    }
    return true;
  }
  const Observer = document.defaultView?.ResizeObserver || globalThis.ResizeObserver;
  if (Observer) new Observer(entries => {
    const measured = entries?.find(entry => entry.target === container)?.contentRect?.width ?? container.getBoundingClientRect().width;
    const nextWidth = Math.max(0, measured - TIMELINE_THUMB_SIZE);
    if (nextWidth === width) return;
    width = nextWidth;
    if (inputs) render();
  }).observe(container);
  // Resolve a generous invisible target once, at the beginning of the shared
  // rail gesture. Direct labels win; overlapping hit areas use the nearest mark.
  function targetAt(pointer: TimelinePointer, metrics?: TimelineGeometry) {
    if (!inputs?.visible || layer.hidden) return null;
    const hitSize = pointer.pointerType === 'touch' || pointer.pointerType === 'pen' ? 44 : 28;
    // A captured drag shares one geometry object. Refresh for every new hover,
    // gesture, resize or marker layout, never measure every node on each move.
    if (!metrics || metrics !== hitMetrics || !hitBoxes) {
      hitMetrics = metrics;
      hitBoxes = targets.flatMap(target => [target.dot, target.symbol].flatMap(element => {
        if (element === target.symbol && target.button.dataset.labelHidden === 'true') return [];
        const rect = element.getBoundingClientRect();
        return rect.width && rect.height ? [{ target, rect }] : [];
      }));
    }
    let winner: { target: ReturnMarkerNode; direct: boolean; distance: number } | null = null;
    for (const { target, rect } of hitBoxes) {
      const x = rect.left + rect.width / 2, y = rect.top + rect.height / 2;
      const dx = Math.abs(pointer.clientX - x), dy = Math.abs(pointer.clientY - y);
      const direct = dx <= rect.width / 2 && dy <= rect.height / 2;
      if (!direct && (dx > Math.max(hitSize, rect.width) / 2 || dy > Math.max(hitSize, rect.height) / 2)) continue;
      const distance = Math.hypot(dx, dy);
      if (!winner || direct && !winner.direct || direct === winner.direct && distance < winner.distance) winner = { target, direct, distance };
    }
    return winner;
  }
  function hitTest(pointer: TimelinePointer, metrics?: TimelineGeometry): TimelineTarget | null {
    const winner = targetAt(pointer, metrics);
    if (!winner) return null;
    const owner = `${inputs!.natal?.id}:${inputs!.natal?.utc}`, target = winner.target, { id, utc } = target.event;
    const valid = () => !!inputs?.visible && `${inputs!.natal?.id}:${inputs!.natal?.utc}` === owner
      && records.get(id) === target && target.event.utc === utc;
    return { direct: winner.direct, distance: winner.distance, valid, title: target.button.title, hover: target.hover, press: target.press,
      select() { if (valid()) onSelect(target!.event); } };
  }
  return { update, hitTest };
}
