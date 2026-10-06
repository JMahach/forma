import { CYCLE_BODIES, LIFE_SPAN_YEARS, cycleLabel, cycleEventLabel } from '../domain/cycles.js';
import { escapeHtml as esc } from '../ui/html.js';
import { attachDatePicker } from './date-picker.js';
import { ageText, returnAge, returnFooter } from './returns-clock.js';
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
  const footer = returnFooter({ natal: state.natal, selectedEvent: event });
  const selected = event.id === state.selectedEvent?.id, pending = event.id === state.pendingEvent?.id;
  const label = eventStatusLabel(selected, pending);
  return `<button type="button" class="returns-event${selected ? ' is-selected' : ''}" data-return-event="${esc(event.id)}" aria-pressed="${selected}"${pending ? ' disabled' : ''}><span class="returns-event-copy"><strong>${esc(cycleEventLabel(event))}</strong><time datetime="${esc(event.utc)}">${esc(footer.date)} · ${esc(footer.detail.split(' · ')[0])}</time></span><span class="returns-event-action"><span>${esc(footer.detail.split(' · ')[1])}</span>${label ? `<small>${label}</small>` : ''}</span></button>`;
}
export function renderReturnEvents(state, now = Date.now()) {
  return renderPreparedReturnEvents(state, firstReturnEvents(state.events || []), now);
}
function renderPreparedReturnEvents(state, events, now) {
  const birth = (state.group === 'major' || state.group === 'planet') && Number.isFinite(Date.parse(state.natal?.utc))
    ? returnFooter({ natal: state.natal }) : null;
  if (!events.length && !birth) return '';
  const dot = '<span class="returns-timeline-dot" aria-hidden="true"></span>';
  const birthRow = birth ? `<div class="returns-timeline-item">${dot}<button type="button" class="returns-event returns-birth${state.birthSelected ? ' is-selected' : ''}" data-return-birth="" aria-pressed="${Boolean(state.birthSelected)}"><span class="returns-event-copy"><strong>Рождение</strong><time datetime="${esc(birth.utc)}">${esc(birth.date)} · ${esc(birth.detail.split(' · ')[0])}</time></span><span class="returns-event-action">0 лет</span></button></div>` : '';
  let marked = false;
  const marker = () => `<div class="returns-timeline-item returns-timeline-now">${dot}<button type="button" class="returns-event returns-now${state.live ? ' is-selected' : ''}" data-return-now="" aria-pressed="${Boolean(state.live)}"><span>Сейчас · ${esc(ageText(returnAge(new Date(now).toISOString(), state.natal)))}</span></button></div>`;
  const rows = events.map(({ event, at }) => {
    const current = !marked && at >= now ? (marked = true, marker()) : '';
    return `${current}<div class="returns-timeline-item">${dot}${eventRow(event, state)}</div>`;
  }).join('');
  return `<div class="returns-timeline">${birthRow}${rows}${marked ? '' : marker()}</div>`;
}

export function attachReturnsPanel({ document, onClose, onGroup, onYear, onBody, onSelect, onBirth = () => {}, onNow = () => {}, onRetry, onLayout = () => {} }) {
  const $ = id => document.getElementById(id);
  const panel = $('returnsPanel'), entry = $('returnsToggle'), backdrop = $('returnsBackdrop');
  const content = $('returnsContent'), status = $('returnsStatus'), year = $('returnsYear'), body = $('returnsBody');
  const natalName = $('returnsNatalName'), momentName = $('returnsMomentName');
  const yearButton = $('returnsYearCalendar');
  const media = document.defaultView.matchMedia('(max-width: 699px)');
  let state = { available: false, timelineVisible: false, opened: false, events: [], errors: [], pendingBodies: [], group: 'major', year: 2026, body: 'saturn' }, markup = '', listSnapshot = null, filterKey = '', jumpPending = false;
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
    if (panel.hidden || state.group !== 'year') return;
    const valid = /^\d{4}$/.test(String(value).trim()) && Number(value) >= Number(year.min) && Number(value) <= Number(year.max);
    year.setAttribute('aria-invalid', String(!valid));
    if (!valid) return;
    year.value = String(Number(value));
    if (Number(value) !== state.year) onYear(Number(value));
  }
  const yearCalendar = attachDatePicker({ input: year, button: yearButton, precision: 'year',
    getBounds: () => ({ min: `${year.min}-01-01`, max: `${year.max}-12-31` }),
    onSelect: value => chooseYear(value.slice(0, 4)),
  });
  function jumpToPresent() {
    if (panel.hidden) return;
    const anchor = content.querySelector('.returns-timeline-now');
    if (!anchor) return;
    const top = Math.max(0, anchor.offsetTop - content.clientHeight * .3);
    content.scrollTop = top;
    jumpPending = false;
  }
  body.innerHTML = CYCLE_BODIES.map(item => `<option value="${item.id}">${esc(item.name)}</option>`).join('');
  $('returnsClose').addEventListener('click', onClose);
  backdrop.addEventListener('click', onClose);
  $('returnsRetry').addEventListener('click', onRetry);
  year.addEventListener('change', () => chooseYear(year.value));
  year.addEventListener('input', () => year.setAttribute('aria-invalid', 'false'));
  year.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); chooseYear(year.value); } });
  body.addEventListener('change', () => onBody(body.value));
  for (const button of panel.querySelectorAll('[data-returns-group]')) button.addEventListener('click', () => onGroup(button.dataset.returnsGroup));
  content.addEventListener('click', event => {
    const button = event.target.closest?.('[data-return-event], [data-return-birth], [data-return-now]');
    if (!button || button.disabled) return;
    if (button.dataset.returnBirth !== undefined) onBirth();
    else if (button.dataset.returnNow !== undefined) onNow();
    else onSelect(button.dataset.returnEvent);
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !panel.hidden) { event.preventDefault(); onClose(); entry.focus({ preventScroll: true }); }
  });
  media.addEventListener?.('change', () => update(state));
  function update(next) {
    const wasVisible = !panel.hidden;
    const nextKey = `${next.natal?.id || next.natal?.utc || ''}:${next.group}:${next.group === 'planet' ? next.body : next.group === 'year' ? next.year : ''}`;
    const nextVisible = Boolean(next.available && next.timelineVisible && next.opened);
    if (nextVisible && (!wasVisible || filterKey !== nextKey)) jumpPending = true;
    filterKey = nextKey;
    state = next;
    panel.hidden = !nextVisible;
    panel.inert = panel.hidden; panel.setAttribute('aria-hidden', String(panel.hidden));
    backdrop.hidden = panel.hidden || !media.matches;
    panel.setAttribute('role', media.matches ? 'dialog' : 'complementary');
    panel.setAttribute('aria-modal', 'false');
    yearButton.disabled = panel.hidden || state.group !== 'year';
    if (yearButton.disabled) yearCalendar.close();
    if (panel.hidden) {
      if (wasVisible) onLayout();
      return;
    }
    const name = state.natal?.name?.trim() || 'Личная карта';
    if (natalName.textContent !== name) { natalName.textContent = name; natalName.title = name; }
    const momentLabel = state.overlayKind === 'transit' ? 'Транзит' : 'Возврат';
    if (momentName.textContent !== momentLabel) momentName.textContent = momentLabel;
    year.min = String(state.minYear || 1801); year.max = String(state.maxYear || 2399);
    if (document.activeElement !== year) { year.value = String(state.year); year.setAttribute('aria-invalid', 'false'); }
    $('returnsYearField').hidden = state.group !== 'year';
    $('returnsBodyField').hidden = state.group !== 'planet'; body.value = state.body;
    for (const button of panel.querySelectorAll('[data-returns-group]')) button.setAttribute('aria-pressed', String(button.dataset.returnsGroup === state.group));
    $('returnsNote').textContent = state.group === 'major' ? `Крупные циклы жизни · до ${LIFE_SPAN_YEARS} лет` : state.group === 'year' ? 'Частые возвраты за выбранный год' : 'Возвраты выбранной планеты';
    const busy = Boolean(state.pendingBodies?.length), events = state.events || [];
    // The controller publishes array copies containing stable exact events.
    // Keep one input snapshot so append/reorder also invalidates preparation.
    if (events.length !== eventInput.length || events.some((event, index) => event !== eventInput[index])) {
      eventInput = [...events]; preparedEvents = firstReturnEvents(events);
    }
    status.textContent = state.loadingChart ? 'Открываем карту возврата…' : state.chartError || (busy ? 'Рассчитываем точные даты…' : !preparedEvents.length && !state.errors?.length ? 'В этом периоде первых касаний нет.' : '');
    panel.setAttribute('aria-busy', String(busy || state.loadingChart));
    $('returnsRetry').hidden = !state.chartError && !state.errors?.length;
    const now = Date.now(), errors = state.errors || [];
    const listKey = JSON.stringify([state.natal?.utc, state.natal?.timezone, state.group,
      preparedEvents.reduce((count, { at }) => count + (at < now), 0),
      returnAge(new Date(now).toISOString(), state.natal), errors]);
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
    if (!wasVisible) { onLayout(); $('returnsClose').focus({ preventScroll: true }); }
  }
  return { update, phone: () => media.matches };
}
