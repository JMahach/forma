import { cycleEventLabel } from '../domain/cycles.js';
import { ageText, returnAge } from './returns-clock.js';

const SYMBOLS = Object.freeze({ saturn: '♄', north_node: '☊', uranus_opposition: '♅', uranus: '♅', chiron: '⚷' });
const MAJOR = new Set(['saturn', 'north_node', 'uranus_opposition', 'chiron', 'uranus']);
const milliseconds = value => typeof value === 'number' ? value : Date.parse(value);

// Each independent lifecycle owns a node at its first exact passage. Pixel
// proximity may arrange labels, but must never remove a different cycle.
export function groupReturnMarkers(events, { fromUtc, toUtc, width } = {}, separation = 20) {
  const from = milliseconds(fromUtc), to = milliseconds(toUtc);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return [];
  const pixels = Number.isFinite(width) ? Math.max(0, width) : 0;
  const distance = Number.isFinite(separation) ? Math.max(0, separation) : 20;
  const points = (Array.isArray(events) ? events : []).filter(event => MAJOR.has(event?.body)
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
  // Keep the rail fixed. Neighboring labels use opposite sides of it, while
  // a small label offset resolves a crowded row without changing any node UTC.
  // Lower labels leave space for the birth and age captions at both endpoints.
  const last = [-Infinity, -Infinity];
  for (const group of groups) {
    const x = group.position * pixels;
    const belowFits = x >= 48 && x <= pixels - 48 && Math.max(x, last[1] + distance) <= pixels - 48;
    const lane = x - last[0] >= distance || !belowFits ? 0 : x - last[1] >= distance ? 1 : last[0] <= last[1] ? 0 : 1;
    group.labelLane = lane ? 'below' : 'above';
    group.labelOffset = pixels ? Math.max(0, last[lane] + distance - x) : 0;
    last[lane] = x + group.labelOffset;
  }
  return groups;
}

function labelsFor(natal) {
  let timeZone = natal?.timezone || 'UTC', format;
  const options = { year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' };
  try { format = new Intl.DateTimeFormat('ru-RU', { ...options, timeZone }); }
  catch { timeZone = 'UTC'; format = new Intl.DateTimeFormat('ru-RU', { ...options, timeZone }); }
  return event => {
    const age = returnAge(event.utc, natal);
    const ageLabel = age === null ? '' : ageText(age);
    const passage = Number.isInteger(event.pass) && event.pass > 0 ? `Проход ${event.pass}` : '';
    const direction = { direct: 'прямой ход', retrograde: 'ретроградный ход', stationary: 'стационарный момент' }[event.direction];
    return [cycleEventLabel(event), `${format.format(new Date(event.utc))} · ${timeZone}`, ageLabel, passage, direction].filter(Boolean).join(' · ');
  };
}

// This layer shares the slider's 22 px rail endpoints. Pointer input passes
// through to the range, which resolves a roomy event tap or a continuous drag.
export function attachReturnMarkers({ container, onSelect = () => {} }) {
  const document = container.ownerDocument;
  const range = container.querySelector('input[type="range"]'), rangeTitle = range?.title || '';
  const layer = document.createElement('div');
  layer.className = 'returns-markers'; layer.hidden = true; container.append(layer);
  let inputs = null, key = null, width = null, labelKey = null, label = null, selectedId = null, targets = [], hovered = null;
  const records = new Map();
  function hover(button) {
    if (hovered === button) return;
    if (hovered) delete hovered.dataset.hovered;
    hovered = button;
    if (hovered) hovered.dataset.hovered = 'true';
    if (range) range.title = hovered?.title || rangeTitle;
  }
  function node(tag, className) {
    const element = document.createElement(tag); element.className = className;
    return element;
  }
  function render() {
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
        target = { button, dot, symbol, hover: active => hover(active ? button : null) };
        button.addEventListener('click', action => { if (!action.detail) onSelect(target.event); });
        records.set(event.id, target);
      }
      target.event = event;
      const { button, symbol } = target;
      button.style.left = `${group.position * 100}%`;
      button.dataset.returnMarker = event.id;
      button.dataset.labelLane = group.labelLane;
      button.style.setProperty('--return-label-offset', `${group.labelOffset}px`);
      const text = label(event);
      button.title = text; button.setAttribute('aria-label', text);
      button.setAttribute('aria-pressed', String(event.id === selectedId));
      const ordinal = Number.isInteger(event.cycle) && event.cycle > 0 ? event.cycle : '';
      symbol.textContent = `${SYMBOLS[event.body]}${ordinal}`;
      if (layer.children[index] !== button) layer.insertBefore(button, layer.children[index] || null);
      return target;
    });
  }
  function update(next) {
    inputs = { ...next, events: Array.isArray(next.events) ? next.events : [] };
    const nextSelected = typeof next.selectedEvent === 'string' ? next.selectedEvent : next.selectedEvent?.id;
    if (nextSelected !== selectedId) {
      records.get(selectedId)?.button.setAttribute('aria-pressed', 'false');
      records.get(nextSelected)?.button.setAttribute('aria-pressed', 'true');
      selectedId = nextSelected;
    }
    // State snapshots copy the array. Compare only input facts before grouping,
    // formatting dates or touching layout; selection changes only two buttons.
    const nextKey = JSON.stringify([Boolean(next.visible), next.fromUtc, next.toUtc, next.natal?.id, next.natal?.utc, next.natal?.timezone,
      inputs.events.map(event => [event?.id, event?.body, event?.utc, event?.cycle, event?.cycleId, event?.pass, event?.direction])]);
    if (nextKey === key) return;
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
  function targetAt(pointer) {
    if (!inputs?.visible || layer.hidden) return null;
    const hitSize = pointer.pointerType === 'touch' || pointer.pointerType === 'pen' ? 44 : 28;
    let winner = null;
    for (const target of targets) for (const element of [target.dot, target.symbol]) {
      const rect = element.getBoundingClientRect();
      if (!rect.width || !rect.height) continue;
      const x = rect.left + rect.width / 2, y = rect.top + rect.height / 2;
      const dx = Math.abs(pointer.clientX - x), dy = Math.abs(pointer.clientY - y);
      const direct = dx <= rect.width / 2 && dy <= rect.height / 2;
      if (!direct && (dx > Math.max(hitSize, rect.width) / 2 || dy > Math.max(hitSize, rect.height) / 2)) continue;
      const distance = Math.hypot(dx, dy);
      if (!winner || direct && !winner.direct || direct === winner.direct && distance < winner.distance) winner = { target, direct, distance };
    }
    return winner;
  }
  function hitTest(pointer) {
    const winner = targetAt(pointer);
    if (!winner) return null;
    const owner = `${inputs.natal?.id}:${inputs.natal?.utc}`, target = winner.target, { id, utc } = target.event;
    const valid = () => inputs?.visible && `${inputs.natal?.id}:${inputs.natal?.utc}` === owner
      && records.get(id) === target && target.event.utc === utc;
    return { direct: winner.direct, distance: winner.distance, valid, title: target.button.title, hover: target.hover,
      select() { if (valid()) onSelect(target.event); } };
  }
  return { update, hitTest };
}
