import { createLifetimeExplorer } from '../state/lifetime.js';
import { bindNumericInput, formatDateInput, normalizeDate } from './date-input.js';
import { attachTimelineRange, isReferenceMoment } from './timeline-range.js';
import { attachTimelineMarks } from './timeline-marks.js';
import { attachDatePicker } from './date-picker.js';
import { formatTimelineMinute, localDateAt, timelineMinute } from '../domain/day-timeline.js';
import { setText } from '../ui/html.js';

function clock(utc, timeZone = null) {
  const value = typeof utc === 'number' ? utc : Date.parse(utc);
  if (!Number.isFinite(value)) return null;
  const iso = new Date(value).toISOString();
  if (timeZone) {
    const local = formatTimelineMinute({ startUtc: value, minutes: 1, timeZone }, 0);
    return { date: formatDateInput(localDateAt(value, timeZone)), time: local.time, zone: local.offset, utc: iso };
  }
  const time = value % 60000 === 0 ? iso.slice(11, 16) : iso.slice(11, 23).replace(/\.000$/, '');
  return { date: formatDateInput(iso.slice(0, 10)), time, zone: 'UTC', utc: iso };
}

export function attachLifetimeControls({ toggle, panel, range, fromDate, toDate, status, fromError = null, toError = null,
  hourMarks = null, fromCalendar = null, toCalendar = null, marker = null, available = true,
  onDayScrub = () => {}, onDayNow = () => {}, onLifetimeNow = () => false, beforeScrub = () => {},
  formatEndpoints = () => null, onMomentInput = () => {}, resolveTap, ...options }) {
  const marks = panel.querySelectorAll('[data-lifetime-date]');
  const rangeLabel = panel.querySelectorAll('label[for="lifetimeTime"]')[0];
  const inputs = [fromDate, toDate], dirty = new Set();
  const dateErrors = new Map([[fromDate, fromError], [toDate, toError]]);
  let inputError = false, submitted = null, wasOpened = false, waitingForMetadata = false;
  let momentClockShown = false;
  let visibleWindow = null;
  const calendars = [];
  const timelineMarks = attachTimelineMarks(hourMarks);
  function scrub(value) {
    if (!explorer.state.opened) return;
    onMomentInput();
    if (beforeScrub(value) === false) return;
    if (explorer.state.mode === 'day') onDayScrub(value);
    else {
      explorer.scrub(value, visibleWindow);
      // A no-op request between available samples still restores the accepted
      // UTC position after the native input has moved its thumb.
      range.value = String(explorer.state.requestedUtc);
    }
  }
  const dayRange = attachTimelineRange({ range, marker, resolveTap, onScrub: scrub,
    onInteractionChange: active => explorer.setInteracting(active),
    resolveEdge({ min, max, value }) {
      const state = explorer.state;
      if (range.disabled || state.mode !== 'lifetime' || !state.metadata || value !== state.requestedUtc || value < min || value > max) return null;
      // Only the existing time owner knows the last available cached/grid point.
      const previous = explorer.adjacentUtc(-1), next = explorer.adjacentUtc(1);
      if (Number.isFinite(previous) && (previous === value || previous < min)) return 'start';
      if (Number.isFinite(next) && (next === value || next > max)) return 'end';
      return null;
    },
    onStep(direction) {
      if (explorer.state.mode === 'lifetime') {
        const next = explorer.adjacentUtc(direction);
        return Number.isFinite(next) ? Math.max(Number(range.min), Math.min(Number(range.max), next)) : next;
      }
      const day = options.getDayState?.();
      return Math.max(0, Math.min((day?.timeline?.minutes ?? 1) - 1, (day?.index ?? 0) + direction));
    },
    onReference() {
      if (!explorer.state.opened) return;
      onMomentInput();
      if (explorer.state.mode === 'lifetime' && onLifetimeNow() === true) return;
      const reference = explorer.state.mode === 'day' ? options.getDayState?.()?.referenceIndex : explorer.state.referenceUtc;
      if (beforeScrub(reference) === false) return;
      if (explorer.state.mode === 'day') onDayNow();
      else explorer.goNow();
    },
  });

  function updateDates(state, preparingDate = null) {
    if (submitted && state.fromDate === submitted.from && state.toDate === submitted.to) {
      if (fromDate.value === submitted.fromText) dirty.delete(fromDate);
      if (toDate.value === submitted.toText) dirty.delete(toDate);
      submitted = null;
    }
    toDate.placeholder = state.openEnded && !preparingDate ? 'До конца' : 'ДД.ММ.ГГГГ';
    for (const [input, value] of [[fromDate, preparingDate || state.fromDate], [toDate, preparingDate || state.toDate]]) {
      // Live minute updates and lifetime completions must not replace either
      // unfinished input, including the first field after the user presses Tab.
      if (!dirty.has(input) && panel.ownerDocument.activeElement !== input && value) {
        const formatted = input === toDate && state.openEnded && !preparingDate ? '' : formatDateInput(value);
        if (input.value !== formatted) input.value = formatted;
      }
    }
    const endpoints = !preparingDate && state.opened && state.mode === 'lifetime' ? formatEndpoints(state)
      ?? [formatDateInput(state.fromDate), formatDateInput(state.toDate)] : ['', ''];
    if (marks[0]) setText(marks[0], endpoints[0]);
    if (marks[1]) setText(marks[1], endpoints[1]);
  }

  function update(state, momentState = options.getMomentState?.(), notify = true) {
    if (wasOpened && !state.opened) { calendars.forEach(calendar => calendar.close()); dirty.clear(); clearInputError(); submitted = null; waitingForMetadata = false; }
    wasOpened = state.opened;
    toggle.hidden = !available;
    panel.hidden = !state.opened;
    const preparing = state.status === 'preparing';
    const transitDay = options.getDayState?.();
    const dayMode = state.mode === 'day' || preparing && Boolean(transitDay);
    if (rangeLabel) setText(rangeLabel, dayMode ? 'Шкала дня: время транзита' : 'Шкала выбранных лет: время UTC');
    if (dayMode || !state.opened) momentState = null;
    momentClockShown = Boolean(momentState);
    const day = dayMode ? transitDay : null;
    const dayReady = day?.status === 'ready' && Boolean(day.timeline);
    // A ready chart cannot acknowledge a file that has not opened yet.
    const fileStatus = !state.metadata && ['loading', 'preparing', 'error'].includes(state.status);
    const requestStatus = fileStatus ? state.status : momentState ? momentState.status : dayMode && ['idle', 'loading', 'error'].includes(day?.status) ? day.status : state.status;
    const retryCount = (fileStatus ? state : momentState || (dayMode ? day : state))?.retryCount ?? 0;
    const displayStatus = requestStatus === 'error' && retryCount > 0 ? 'loading' : requestStatus;
    panel.dataset.status = displayStatus;
    panel.dataset.mode = state.mode;
    panel.setAttribute('aria-busy', String(displayStatus === 'loading' || preparing));
    range.disabled = preparing || (dayMode ? !dayReady : !state.metadata);
    for (const input of inputs) input.disabled = preparing;
    if (fromCalendar) fromCalendar.disabled = !state.metadata;
    if (toCalendar) toCalendar.disabled = !state.metadata;
    const window = !dayMode && visibleWindow ? visibleWindow : state;
    range.min = dayMode ? '0' : String(window.minUtc ?? 0);
    range.max = String(dayMode ? Math.max(0, (day?.timeline?.minutes ?? 1) - 1) : window.maxUtc ?? 0);
    range.step = dayMode ? '1' : 'any';
    if (!state.opened) timelineMarks.clear();
    else if (dayMode) {
      timelineMarks.day(day?.timeline, day?.timeline?.minutes, (timeline, index) => formatTimelineMinute(timeline, index).time);
    } else {
      timelineMarks.life(options.getPersonalChart?.(), Number(range.min), Number(range.max));
    }
    const momentUtc = momentState?.current && state.metadata ? Math.max(state.minUtc, Math.min(state.maxUtc,
      Date.parse(momentState.current.utc))) : null;
    const cursor = dayMode ? day?.index ?? 0 : momentUtc ?? state.requestedUtc ?? 0;
    const cursorVisible = dayMode || cursor >= Number(range.min) && cursor <= Number(range.max);
    range.setAttribute('data-cursor-visible', String(cursorVisible));
    range.value = String(cursor);
    // A pending file previews the existing transit; its saved range stays intact.
    const preparingDate = preparing && (day?.timeline?.date || day?.current?.birthDate);
    updateDates(state, preparingDate);

    const shown = clock(dayMode ? day?.current?.utc || state.current?.utc : momentState ? momentState.current?.utc : state.current?.utc, dayMode ? day?.timeline?.timeZone : null);
    const requested = momentState ? shown : !dayMode && clock(state.requestedUtc);
    const reference = dayMode ? day?.referenceIndex : state.referenceUtc;
    const referenceUtc = dayMode ? day?.timeline && Number.isFinite(reference)
      ? timelineMinute(day.timeline, reference).utc : null : reference;
    const displayedUtc = dayMode ? day?.current?.utc : momentState ? momentState.current?.utc : state.displayedUtc;
    dayRange.updateReference({ value: reference, visible: state.opened && !preparing && (!dayMode || dayReady) && Number.isFinite(reference)
      && reference >= Number(range.min) && reference <= Number(range.max),
      label: 'Вернуться к текущему времени',
      title: !dayMode && options.getPersonalChart?.() ? 'Текущий транзит' : 'Текущий момент',
      active: isReferenceMoment(displayedUtc, referenceUtc) });
    const pending = displayStatus === 'loading';
    const unshown = !dayMode && !momentState && Boolean(state.metadata && state.requestedUtc !== state.displayedUtc && (pending || state.displayedUtc !== null));
    const dayLabel = dayMode && day?.timeline && formatTimelineMinute(day.timeline, day.index ?? 0);
    const selectedLabel = dayLabel ? `${dayLabel.date}, ${dayLabel.time}, ${dayLabel.offset}`
      : requested ? `${requested.date}, ${requested.time} UTC` : '';
    range.setAttribute('aria-valuetext', [selectedLabel, !cursorVisible ? 'на карте, вне выбранного периода' : '',
      pending ? 'загружается' : unshown ? 'не показано' : '',
      unshown && shown ? `на карте ${shown.date}, ${shown.time} ${shown.zone}` : ''].filter(Boolean).join('; '));
    // Temporary failures stay quiet at first; a rejected file needs repair.
    // The request owner decides whether to retry and owns the failure count.
    setText(status, fileStatus && state.status === 'error' ? state.error
      : preparing ? 'Создаём летопись'
      : state.opened && retryCount >= 3 && ['loading', 'error'].includes(displayStatus) ? 'Загружаю момент' : '');
    if (notify) options.onStateChange?.(state);
    if (waitingForMetadata && state.metadata && state.opened) {
      const pending = submitted;
      waitingForMetadata = false;
      queueMicrotask(() => {
        if (explorer.state.opened && pending && fromDate.value === pending.fromText && toDate.value === pending.toText) applyDates();
      });
    }
  }

  const explorer = createLifetimeExplorer({ ...options, onStateChange: update });
  function clearInputError() {
    inputError = false;
    for (const input of inputs) {
      input.setAttribute('aria-invalid', 'false');
      const message = dateErrors.get(input);
      if (message) setText(message, '');
    }
  }
  function showDateError(input, text) {
    inputError = true;
    input.setAttribute('aria-invalid', 'true');
    const message = dateErrors.get(input);
    if (message) setText(message, text);
  }
  function resetEndBeforeStart() {
    let start, end;
    try { start = normalizeDate(fromDate.value); end = normalizeDate(toDate.value); }
    catch { return false; }
    const { minDate, maxDate } = explorer.state;
    if (start <= end || minDate && start < minDate || maxDate && start > maxDate) return false;
    toDate.value = ''; dirty.add(toDate);
    waitingForMetadata = false; submitted = null; clearInputError();
    return true;
  }
  function applyDates(reportIncomplete = true) {
    if (!explorer.state.opened) return;
    clearInputError();
    let incomplete = false;
    const { minDate, maxDate } = explorer.state;
    const [from, through] = inputs.map(input => {
      if (input === toDate && !input.value.trim()) return null;
      const digits = input.value.replace(/\D/g, '').length;
      if (digits > 8) { showDateError(input, 'Дата некорректна'); return null; }
      // A draft is quiet until submit; every complete field owns its error.
      if (!reportIncomplete && digits < 8) {
        incomplete = true; return null;
      }
      let date;
      try { date = normalizeDate(input.value); }
      catch { showDateError(input, 'Дата некорректна'); return null; }
      if (minDate && date < minDate || maxDate && date > maxDate) showDateError(input, 'Вне диапазона');
      return date;
    });
    if (!incomplete && !inputError && through && from > through) showDateError(toDate, 'Вне диапазона');
    if (incomplete || inputError) { update(explorer.state); return; }
    submitted = { from, to: through ?? explorer.state.maxDate, fromText: fromDate.value, toText: toDate.value };
    const result = explorer.setDateRange(from, through);
    if (result === false && !explorer.state.metadata) waitingForMetadata = true;
    update(explorer.state);
    Promise.resolve(result).catch(() => update(explorer.state));
  }

  for (const input of inputs) {
    input.addEventListener('focus', () => input.select());
    input.addEventListener('click', () => input.select());
    // A numeric paste can contain nine digits while still fitting maxlength=10.
    // Retain that invalid draft instead of silently committing its first eight.
    let rawInput = '';
    input.addEventListener('input', () => { rawInput = input.value; });
    bindNumericInput(input, formatDateInput);
    input.addEventListener('input', () => {
      dirty.add(input); clearInputError(); waitingForMetadata = false; submitted = null;
      if (rawInput.replace(/\D/g, '').length > 8) {
        input.value = rawInput;
        input.setSelectionRange(rawInput.length, rawInput.length);
        applyDates(false);
        return;
      }
      if (input === fromDate) resetEndBeforeStart();
      applyDates(false);
    });
    input.addEventListener('keydown', event => {
      if (input === fromDate && event.key === 'Tab' && !event.shiftKey) {
        event.preventDefault(); toDate.focus(); return;
      }
      if (event.key !== 'Enter') return;
      event.preventDefault(); applyDates();
    });
  }
  toDate.addEventListener('change', () => applyDates());
  explorer.setAvailable = value => {
    if (typeof value !== 'boolean' || value === available) return;
    available = value;
    if (!available) explorer.close();
    toggle.hidden = !available;
  };
  explorer.refreshTargets = dayRange.refreshTargets;
  explorer.setVisibleWindow = value => {
    const next = value && Number.isFinite(value.minUtc) && Number.isFinite(value.maxUtc) && value.minUtc <= value.maxUtc
      ? { minUtc: value.minUtc, maxUtc: value.maxUtc } : null;
    if (next?.minUtc === visibleWindow?.minUtc && next?.maxUtc === visibleWindow?.maxUtc) return;
    visibleWindow = next;
    update(explorer.state, options.getMomentState?.(), false);
  };
  // Readiness and the real-clock marker can change without a new chart object.
  // The existing day controller remains the sole owner of its minute range.
  explorer.syncTransit = () => {
    if (explorer.syncDay() || explorer.syncClock()) return;
    const state = explorer.state;
    const momentState = options.getMomentState?.();
    if (state.opened && (state.mode === 'day' || state.status === 'preparing' || momentState || momentClockShown)) update(state, momentState);
  };
  for (const [input, button] of [[fromDate, fromCalendar], [toDate, toCalendar]]) {
    if (!button) continue;
    calendars.push(attachDatePicker({ input, button,
      getBounds: () => ({ min: explorer.state.minDate, max: explorer.state.maxDate }),
      onSelect(value) {
        onMomentInput();
        input.value = formatDateInput(value); dirty.add(input);
        waitingForMetadata = false; submitted = null;
        if (input === fromDate) resetEndBeforeStart();
        applyDates();
      },
    }));
  }
  update(explorer.state);
  return explorer;
}
