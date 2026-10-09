import { CYCLE_BODIES, DEFAULT_CYCLE_BODIES, cycleLabel, cycleEventLabel, cycleCalendarYear } from '../domain/cycles.js';
import { escapeHtml as esc } from '../ui/html.js';
import { attachDatePicker } from './date-picker.js';
import { ageText, completedAge } from '../domain/personal-age.js';
import { returnMomentDetails } from './returns-clock.js';
// A clipped year can begin with pass 2 or 3; it must not invent a first touch.
function firstReturnEvents(events) {
  const first = new Map();
  const ordered = events.filter(event => event.pass === 1).map(event => ({ event, at: Date.parse(event.utc) }))
    .filter(({ at }) => Number.isFinite(at)).sort((a, b) => a.at - b.at);
  for (const record of ordered) {
    const { event } = record;
    const key = event.cycleId || event.id;
    if (!first.has(key)) first.set(key, record);
  }
  return [...first.values()];
}
const eventStatusLabel = (selected, pending) => pending ? 'Открываем…' : selected ? 'На карте' : '';
function eventRow(event, state) {
  const moment = returnMomentDetails(event.utc, state.natal);
  const selected = event.id === state.selectedEvent?.id, pending = event.id === state.pendingEvent?.id;
  const label = eventStatusLabel(selected, pending);
  return `<button type="button" class="returns-event${selected ? ' is-selected' : ''}" data-return-event="${esc(event.id)}" aria-pressed="${selected}"${pending ? ' disabled' : ''}><span class="returns-event-copy"><strong>${esc(cycleEventLabel(event))}</strong><time datetime="${esc(event.utc)}">${esc(moment.date)} · ${esc(moment.time)}</time></span><span class="returns-event-action"><span>${esc(moment.age)}</span>${label ? `<small>${label}</small>` : ''}</span></button>`;
}
export function renderReturnEvents(state, now = Date.now()) {
  return renderPreparedReturnEvents(state, firstReturnEvents(state.events || []), now);
}
const inSelectedYear = (state, utc) => state.year == null || cycleCalendarYear(utc, state.natal?.timezone) === state.year;
const showPresent = (state, now) => now >= Date.parse(state.natal?.utc) && inSelectedYear(state, now);
function renderPreparedReturnEvents(state, events, now) {
  const birth = Number.isFinite(Date.parse(state.natal?.utc)) && inSelectedYear(state, state.natal.utc)
    ? returnMomentDetails(state.natal.utc, state.natal) : null;
  const showNow = showPresent(state, now);
  if (!events.length && !birth && !showNow) return '';
  const dot = '<span class="returns-timeline-dot" aria-hidden="true"></span>';
  const birthRow = birth ? `<div class="returns-timeline-item">${dot}<button type="button" class="returns-event returns-birth${state.birthSelected ? ' is-selected' : ''}" data-return-birth="" aria-pressed="${Boolean(state.birthSelected)}"><span class="returns-event-copy"><strong>Рождение</strong><time datetime="${esc(birth.utc)}">${esc(birth.date)} · ${esc(birth.time)}</time></span><span class="returns-event-action">0 лет</span></button></div>` : '';
  let marked = false;
  const marker = () => showNow ? `<div class="returns-timeline-item returns-timeline-now">${dot}<button type="button" class="returns-event returns-now${state.live ? ' is-selected' : ''}" data-return-now="" aria-pressed="${Boolean(state.live)}"><span>Сейчас · ${esc(ageText(completedAge(new Date(now).toISOString(), state.natal)))}</span></button></div>` : '';
  const rows = events.map(({ event, at }) => {
    const current = !marked && at >= now ? (marked = true, marker()) : '';
    return `${current}<div class="returns-timeline-item" data-cycle-body="${esc(event.body)}">${dot}${eventRow(event, state)}</div>`;
  }).join('');
  return `<div class="returns-timeline">${birthRow}${rows}${marked ? '' : marker()}</div>`;
}

export function attachReturnsPanel({ document, getLayout = () => 'sheet', onClose, onBack, onYear, onBodies, onSelect, onBirth = () => {}, onNow = () => {}, onRetry, onLayout = () => {} }) {
  const $ = id => document.getElementById(id);
  const panel = $('returnsPanel');
  let visible = false;
  const content = $('returnsContent'), status = $('returnsStatus'), year = $('returnsYear'), body = $('returnsBody');
  const yearButton = $('returnsYearCalendar');
  const bodyButton = $('returnsBodiesToggle'), bodyMenu = $('returnsBodyMenu');
  const sheet = () => getLayout() === 'sheet';
  let state = { available: false, timelineVisible: false, opened: false, events: [], errors: [], pendingBodies: [], year: null, bodies: [] }, markup = '', listSnapshot = null, filterKey = '', jumpPending = false;
  const checks = new Map();
  bodyMenu.hidden = true;
  function closeBodies(restoreFocus = false) {
    if (bodyMenu.hidden) return;
    bodyMenu.hidden = true; bodyButton.setAttribute('aria-expanded', 'false');
    if (restoreFocus) bodyButton.focus({ preventScroll: true });
  }
  for (const item of CYCLE_BODIES) {
    const row = document.createElement('label'), input = document.createElement('input');
    const symbol = document.createElement('span'), name = document.createElement('span');
    row.className = 'returns-body-option'; row.dataset.cycleBody = item.id;
    input.type = 'checkbox'; input.dataset.cycleBody = item.id; input.setAttribute('aria-label', item.name);
    symbol.className = 'returns-body-symbol'; symbol.textContent = item.symbol; symbol.setAttribute('aria-hidden', 'true');
    name.textContent = item.name;
    row.append(input, symbol, name); body.append(row); checks.set(item.id, input);
    input.addEventListener('change', () => {
      const selected = state.bodies || [];
      onBodies(input.checked ? [...new Set([...selected, item.id])] : selected.filter(id => id !== item.id));
    });
  }
  yearButton.addEventListener('click', () => closeBodies());
  let eventInput = [], preparedEvents = [];
  let rows = new Map(), paintedSelection = null, paintedPending = null;
  let birthRow = null, nowRow = null;
  function paintMomentState() {
    for (const [node, selected] of [[birthRow, Boolean(state.birthSelected)], [nowRow, Boolean(state.live)]]) {
      if (!node || node.getAttribute('aria-pressed') === String(selected)) continue;
      node.classList.toggle('is-selected', selected);
      node.setAttribute('aria-pressed', String(selected));
    }
  }
  function paintEventState() {
    const selected = state.selectedEvent?.id, pending = state.pendingEvent?.id;
    if (selected === paintedSelection && pending === paintedPending) return;
    // Dates and labels belong to the list snapshot. Only the previously and
    // newly active buttons change while an exact return opens.
    for (const id of new Set([paintedSelection, paintedPending, selected, pending])) {
      const row = rows.get(id);
      if (!row) continue;
      const isSelected = id === selected, isPending = id === pending;
      if (isSelected === (id === paintedSelection) && isPending === (id === paintedPending)) continue;
      if (isSelected !== (id === paintedSelection)) {
        row.node.classList.toggle('is-selected', isSelected);
        row.node.setAttribute('aria-pressed', String(isSelected));
      }
      if (isPending !== (id === paintedPending)) row.node.disabled = isPending;
      if (!row.action) {
        row.action = row.node.querySelector('.returns-event-action');
        row.status = row.action.querySelector('small');
      }
      const label = eventStatusLabel(isSelected, isPending);
      if (label) {
        row.status ||= row.node.ownerDocument.createElement('small');
        if (row.status.textContent !== label) row.status.textContent = label;
        if (row.status.parentNode !== row.action) row.action.appendChild(row.status);
      } else row.status?.remove();
    }
    paintedSelection = selected; paintedPending = pending;
  }
  function chooseYear(value) {
    if (!visible) return;
    const valid = /^\d{4}$/.test(String(value).trim()) && Number(value) >= Number(year.min) && Number(value) <= Number(year.max);
    year.setAttribute('aria-invalid', String(!valid));
    if (!valid) return;
    year.value = String(Number(value));
    if (Number(value) !== state.year) onYear(Number(value));
  }
  const yearCalendar = attachDatePicker({ input: year, button: yearButton, precision: 'year',
    presentation: { className: 'returns-filter-popover', title: 'Период', preferBelow: true,
      getBounds: () => {
        const bounds = panel.getBoundingClientRect();
        const modes = $('summarySwitch').getBoundingClientRect();
        return { left: bounds.left + 10, right: bounds.right - 10,
          top: Math.max(bounds.top + 8, modes.bottom + 8), bottom: bounds.bottom - 8 };
      },
    },
    getBounds: () => ({ min: `${year.min}-01-01`, max: `${year.max}-12-31` }),
    onSelect: value => chooseYear(value.slice(0, 4)),
    clearLabel: 'Вся жизнь', onClear: () => onYear(null),
    getInitialDate: () => `${new Date().getFullYear()}-01-01`,
  });
  function jumpToPresent() {
    if (!visible) return;
    const anchor = content.querySelector('.returns-timeline-now');
    if (!anchor) { content.scrollTop = 0; jumpPending = false; return; }
    const top = Math.max(0, anchor.offsetTop - content.clientHeight * .3);
    content.scrollTop = top;
    jumpPending = false;
  }
  bodyButton.addEventListener('click', () => {
    const opening = bodyMenu.hidden;
    yearCalendar.close();
    bodyMenu.hidden = !opening; bodyButton.setAttribute('aria-expanded', String(opening));
    if (opening) checks.values().next().value?.focus({ preventScroll: true });
  });
  $('returnsBodiesClose').addEventListener('click', () => closeBodies(true));
  $('returnsBodiesClear').addEventListener('click', () => onBodies([]));
  $('returnsBodiesDefault').addEventListener('click', () => onBodies([...DEFAULT_CYCLE_BODIES]));
  document.addEventListener('pointerdown', event => {
    if (!bodyMenu.hidden && !bodyMenu.contains(event.target) && !bodyButton.contains(event.target)) closeBodies();
  }, true);
  document.addEventListener('focusin', event => {
    if (!bodyMenu.hidden && !bodyMenu.contains(event.target) && !bodyButton.contains(event.target)) closeBodies();
  });
  $('returnsClose').addEventListener('click', onClose);
  $('returnsBack').addEventListener('click', onBack);
  $('returnsRetry').addEventListener('click', onRetry);
  year.addEventListener('change', () => chooseYear(year.value));
  year.addEventListener('input', () => year.setAttribute('aria-invalid', 'false'));
  year.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); chooseYear(year.value); } });
  content.addEventListener('click', event => {
    const button = event.target.closest?.('[data-return-event], [data-return-birth], [data-return-now]');
    if (!button || button.disabled) return;
    if (button.dataset.returnBirth !== undefined) onBirth();
    else if (button.dataset.returnNow !== undefined) onNow();
    else onSelect(button.dataset.returnEvent);
  });
  panel.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || !visible) return;
    if (!bodyMenu.hidden) { event.preventDefault(); closeBodies(true); }
    else if (yearCalendar.opened) { event.preventDefault(); yearCalendar.close(true); }
    // Unhandled Escape bubbles to the shared About drawer owner.
  });
  function update(next) {
    const wasVisible = visible;
    const nextKey = JSON.stringify([next.natal?.id || next.natal?.utc, next.year, next.bodies]);
    const nextVisible = Boolean(next.available && next.timelineVisible && next.opened);
    const loadingStarted = !state.pendingBodies?.length && Boolean(next.pendingBodies?.length);
    if (nextVisible && (!wasVisible || filterKey !== nextKey || loadingStarted)) jumpPending = true;
    filterKey = nextKey;
    state = next;
    visible = nextVisible;
    yearButton.disabled = !visible;
    if (yearButton.disabled) yearCalendar.close();
    if (!visible) {
      closeBodies();
      if (wasVisible) onLayout();
      return;
    }
    year.min = String(state.minYear || 1801); year.max = String(state.maxYear || 2399);
    if (document.activeElement !== year) { year.value = state.year == null ? '' : String(state.year); year.setAttribute('aria-invalid', 'false'); }
    $('returnsYearLabel').textContent = state.year == null ? 'Вся жизнь' : String(state.year);
    $('returnsBodiesLabel').textContent = `Планеты · ${state.bodies?.length || 0}`;
    for (const [id, input] of checks) input.checked = Boolean(state.bodies?.includes(id));
    $('returnsBodiesClear').disabled = !state.bodies?.length;
    $('returnsNote').textContent = state.year == null ? 'Возвраты выбранных планет за всю жизнь' : `Возвраты выбранных планет за ${state.year} год`;
    const busy = Boolean(state.pendingBodies?.length), events = state.events || [];
    // The controller publishes array copies containing stable exact events.
    // Keep one input snapshot so append/reorder also invalidates preparation.
    if (events.length !== eventInput.length || events.some((event, index) => event !== eventInput[index])) {
      eventInput = [...events]; preparedEvents = firstReturnEvents(events);
    }
    status.textContent = state.loadingChart ? 'Открываем карту возврата…' : state.chartError || (busy ? 'Рассчитываем точные даты…' : !state.bodies?.length ? 'Выберите планеты, чтобы показать возвраты.' : !preparedEvents.length && !state.errors?.length ? 'В этом периоде первых касаний нет.' : '');
    panel.setAttribute('aria-busy', String(busy || state.loadingChart));
    $('returnsRetry').hidden = !state.chartError && !state.errors?.length;
    const now = Date.now(), errors = state.errors || [];
    const listKey = JSON.stringify([state.natal?.utc, state.natal?.timezone, state.year, showPresent(state, now),
      preparedEvents.reduce((count, { at }) => count + (at < now), 0),
      completedAge(new Date(now).toISOString(), state.natal), errors]);
    const unchanged = listSnapshot?.key === listKey && listSnapshot.events === preparedEvents;
    if (!unchanged) {
      const nextMarkup = renderPreparedReturnEvents(state, preparedEvents, now) + errors.map(error => `<p class="returns-error">${esc(cycleLabel(error.body))}: ${esc(error.message)}</p>`).join('');
      listSnapshot = { key: listKey, events: preparedEvents };
      if (nextMarkup !== markup) {
        const focused = document.activeElement?.dataset, scroll = content.scrollTop;
        markup = nextMarkup; content.innerHTML = markup;
        rows = new Map([...content.querySelectorAll('[data-return-event]')].map(node => [node.dataset.returnEvent, { node }]));
        birthRow = content.querySelector('[data-return-birth]'); nowRow = content.querySelector('[data-return-now]');
        paintedSelection = state.selectedEvent?.id; paintedPending = state.pendingEvent?.id;
        const focusTarget = focused?.returnBirth !== undefined ? birthRow : focused?.returnNow !== undefined ? nowRow : rows.get(focused?.returnEvent)?.node;
        focusTarget?.focus({ preventScroll: true });
        content.scrollTop = scroll;
      }
    }
    paintEventState();
    paintMomentState();
    if (jumpPending && !busy) jumpToPresent();
    if (!wasVisible) { onLayout(); $('returnsBack').focus({ preventScroll: true }); }
  }
  return { update, sheet };
}
