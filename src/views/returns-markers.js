import { CYCLE_BODIES, cycleEventLabel, cycleTimeZone } from '../domain/cycles.js';
import { isReferenceMoment } from './timeline-range.js';
import { ageText, completedAge } from '../domain/personal-age.js';

const SYMBOLS = Object.fromEntries(CYCLE_BODIES.map(body => [body.id, body.symbol]));
const BODIES = new Set(CYCLE_BODIES.map(body => body.id));
const milliseconds = value => typeof value === 'number' ? value : Date.parse(value);

// Each independent lifecycle owns a node at its first exact passage. Pixel
// proximity may arrange labels, but must never remove a different cycle.
export function groupReturnMarkers(events, { fromUtc, toUtc, width } = {}, separation = 20) {
  const from = milliseconds(fromUtc), to = milliseconds(toUtc);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return [];
  const pixels = Number.isFinite(width) ? Math.max(0, width) : 0;
  const distance = Number.isFinite(separation) ? Math.max(0, separation) : 20;
  const points = (Array.isArray(events) ? events : []).filter(event => BODIES.has(event?.body)
    && typeof event.id === 'string' && Number.isFinite(Date.parse(event.utc))
    && Date.parse(event.utc) >= from && Date.parse(event.utc) <= to)
    .map(event => ({ event, utc: Date.parse(event.utc) })).sort((a, b) => a.utc - b.utc);
  const groups = [], cycles = new Map();
  for (const point of points) {
    const cycle = Number.isInteger(point.event.cycle) && point.event.cycle > 0 ? point.event.cycle : point.event.cycleId || point.event.id;
    const key = `${point.event.body}:${cycle}`;
    if (cycles.has(key)) cycles.get(key).events.push(point.event);
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
    const belowFits = center >= 48 && center <= pixels - 48 && center - last[1] >= gap;
    const lane = center - last[0] >= gap || !belowFits ? 0 : 1;
    const placed = Math.max(center, last[lane] + gap);
    group.labelLane = lane ? 'below' : 'above';
    group.labelHidden = pixels > 0 && (placed > pixels - half || Math.abs(placed - x) > gap);
    group.labelOffset = pixels && !group.labelHidden ? placed - x : 0;
    if (!group.labelHidden) last[lane] = placed;
  }
  return groups;
}

function labelsFor(natal) {
  const timeZone = cycleTimeZone(natal?.timezone);
  const options = { year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' };
  const format = new Intl.DateTimeFormat('ru-RU', { ...options, timeZone });
  return event => {
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
export function attachReturnMarkers({ container, onSelect = () => {}, onTargetsChange = () => {} }) {
  const document = container.ownerDocument;
  const layer = document.createElement('div');
  layer.className = 'returns-markers'; layer.hidden = true; container.append(layer);
  let inputs = null, key = null, width = null, labelKey = null, label = null, targets = [], hovered = null, hitMetrics = null, hitBoxes = null;
  const records = new Map();
  function hover(button) {
    if (hovered === button) return;
    if (hovered) delete hovered.dataset.hovered;
    hovered = button;
    if (hovered) hovered.dataset.hovered = 'true';
  }
  function node(tag, className) {
    const element = document.createElement(tag); element.className = className;
    return element;
  }
  function updateActive() {
    const displayed = milliseconds(inputs.displayedUtc);
    for (const target of targets) {
      const active = String(isReferenceMoment(displayed, target.utc));
      if (target.button.getAttribute('aria-pressed') !== active) target.button.setAttribute('aria-pressed', active);
    }
  }
  function render() {
    hitMetrics = null; hitBoxes = null;
    const { events, natal, fromUtc, toUtc, visible } = inputs;
    if (visible && width === null) width = Math.max(0, container.getBoundingClientRect().width - 44);
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
        button.append(dot, symbol);
        target = { button, dot, symbol, hover: active => hover(active ? button : null),
          press: active => { if (active) button.dataset.pressed = 'true'; else delete button.dataset.pressed; } };
        button.addEventListener('click', action => { if (!action.detail) onSelect(target.event); });
        records.set(event.id, target);
      }
      target.event = event; target.utc = Date.parse(event.utc);
      const { button, symbol } = target;
      button.style.left = `${group.position * 100}%`;
      button.dataset.returnMarker = event.id;
      button.dataset.cycleBody = event.body;
      button.dataset.labelLane = group.labelLane;
      button.dataset.labelHidden = String(group.labelHidden);
      button.style.setProperty('--return-label-offset', `${group.labelOffset}px`);
      const text = label(event);
      button.title = text; button.setAttribute('aria-label', text);
      const ordinal = event.body !== 'uranus_opposition' && Number.isInteger(event.cycle) && event.cycle > 0 ? event.cycle : '';
      symbol.textContent = `${SYMBOLS[event.body]}${ordinal}`;
      if (layer.children[index] !== button) layer.insertBefore(button, layer.children[index] || null);
      return target;
    });
    updateActive();
    onTargetsChange();
  }
  function update(next) {
    inputs = { ...next, events: Array.isArray(next.events) ? next.events : [] };
    // Clock changes update only changed indicators; labels and layout stay intact.
    const nextKey = JSON.stringify([Boolean(next.visible), next.fromUtc, next.toUtc, next.natal?.id, next.natal?.utc, next.natal?.timezone,
      inputs.events.map(event => [event?.id, event?.body, event?.utc, event?.cycle, event?.cycleId, event?.pass, event?.direction])]);
    if (nextKey === key) { updateActive(); return; }
    key = nextKey; render();
  }
  const Observer = document.defaultView?.ResizeObserver || globalThis.ResizeObserver;
  if (Observer) new Observer(entries => {
    const measured = entries?.find(entry => entry.target === container)?.contentRect?.width ?? container.getBoundingClientRect().width;
    const nextWidth = Math.max(0, measured - 44);
    if (nextWidth === width) return;
    width = nextWidth;
    if (inputs) render();
  }).observe(container);
  // Resolve a generous invisible target once, at the beginning of the shared
  // rail gesture. Direct labels win; overlapping hit areas use the nearest mark.
  function targetAt(pointer, metrics) {
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
    let winner = null;
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
  function hitTest(pointer, metrics) {
    const winner = targetAt(pointer, metrics);
    if (!winner) return null;
    const owner = `${inputs.natal?.id}:${inputs.natal?.utc}`, target = winner.target, { id, utc } = target.event;
    const valid = () => inputs?.visible && `${inputs.natal?.id}:${inputs.natal?.utc}` === owner
      && records.get(id) === target && target.event.utc === utc;
    return { direct: winner.direct, distance: winner.distance, valid, title: target.button.title, hover: target.hover, press: target.press,
      select() { if (valid()) onSelect(target.event); } };
  }
  return { update, hitTest };
}
