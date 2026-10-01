import { createLifetimeExplorer } from '../state/lifetime.js';
import { bindNumericInput, formatDateInput, normalizeDate } from './date-input.js';
import { attachDayRange } from './day-range.js';
import { attachDatePicker } from './date-picker.js';
import { formatTimelineMinute, localDateAt } from '../domain/day-timeline.js';
import { setText } from '../ui/html.js';

function clock(utc, timeZone = null) {
  const value = Date.parse(utc);
  if (!Number.isFinite(value)) return null;
  const iso = new Date(value).toISOString();
  if (timeZone) {
    const local = formatTimelineMinute({ startUtc: value, minutes: 1, timeZone }, 0);
    return { date: formatDateInput(localDateAt(value, timeZone)), time: local.time, zone: local.offset, utc: iso };
  }
  return { date: formatDateInput(iso.slice(0, 10)), time: iso.slice(11, 16), zone: 'UTC', utc: iso };
}

export function attachLifetimeControls({ toggle, panel, range, fromDate, toDate, date, time, status,
  retryButton = null, fromCalendar = null, toCalendar = null, marker = null, enabled = true, available = true,
  onDayScrub = () => {}, onDayNow = () => {}, ...options }) {
  const marks = panel.querySelectorAll('[data-lifetime-date]');
  const inputs = [fromDate, toDate], dirty = new Set();
  let inputError = '', submitted = null, wasOpened = false, waitingForMetadata = false;
  let momentLoading = null;
  const calendars = [];
  const dayRange = attachDayRange({ range, marker,
    onScrub(value) {
      if (!explorer.state.opened) return;
      if (explorer.state.mode === 'day') onDayScrub(value);
      else explorer.scrub(value);
    },
    onReference() {
      if (!explorer.state.opened) return;
      if (explorer.state.mode === 'day') onDayNow();
      else explorer.goNow();
    },
  });

  function updateDates(state) {
    if (submitted && state.fromDate === submitted.from && state.toDate === submitted.to) {
      if (fromDate.value === submitted.fromText) dirty.delete(fromDate);
      if (toDate.value === submitted.toText) dirty.delete(toDate);
      submitted = null;
    }
    for (const [input, value] of [[fromDate, state.fromDate], [toDate, state.toDate]]) {
      // Live minute updates and archive completions must not replace either
      // unfinished input, including the first field after the user presses Tab.
      if (!dirty.has(input) && panel.ownerDocument.activeElement !== input && value) {
        const formatted = formatDateInput(value);
        if (input.value !== formatted) input.value = formatted;
      }
    }
    if (marks[0]) setText(marks[0], state.mode === 'archive' ? formatDateInput(state.fromDate) : '');
    if (marks[1]) setText(marks[1], state.mode === 'archive' ? formatDateInput(state.toDate) : '');
  }

  function update(state) {
    if (wasOpened && !state.opened) { calendars.forEach(calendar => calendar.close()); dirty.clear(); clearInputError(); submitted = null; waitingForMetadata = false; }
    wasOpened = state.opened;
    toggle.hidden = !enabled || !available;
    toggle.setAttribute('aria-expanded', String(state.opened));
    toggle.setAttribute('aria-pressed', String(state.opened));
    toggle.title = state.opened ? 'Шкала годов · закрыть' : 'Шкала годов';
    panel.hidden = !state.opened;
    const dayMode = state.mode === 'day';
    const day = dayMode ? options.getDayState?.() : null;
    const dayReady = day?.status === 'ready' && Boolean(day.timeline);
    const displayStatus = dayMode && ['idle', 'loading', 'error'].includes(day?.status) ? day.status : state.status;
    panel.dataset.status = displayStatus;
    panel.dataset.mode = state.mode;
    panel.setAttribute('aria-busy', String(displayStatus === 'loading'));
    range.hidden = false;
    if (range.parentElement) range.parentElement.hidden = false;
    range.disabled = dayMode ? !dayReady : !state.metadata;
    if (fromCalendar) fromCalendar.disabled = !state.metadata;
    if (toCalendar) toCalendar.disabled = !state.metadata;
    range.min = dayMode ? '0' : String(state.minIndex ?? 0);
    range.max = String(dayMode ? Math.max(0, (day?.timeline?.minutes ?? 1) - 1) : state.maxIndex ?? 0);
    range.step = '1';
    range.value = String(dayMode ? day?.index ?? 0 : state.index ?? 0);
    updateDates(state);

    const shown = clock(dayMode ? day?.current?.utc || state.current?.utc : state.current?.utc, dayMode ? day?.timeline?.timeZone : null);
    setText(date, shown?.date || '');
    setText(time, shown ? `${shown.time} · ${shown.zone}` : '');
    time.dateTime = shown?.utc || '';
    time.title = dayMode ? day?.timeline?.timeZone || 'Время показанной карты' : 'Время показанной карты · UTC';
    const requested = !dayMode && state.metadata && clock(new Date(Date.parse(state.metadata.startUtc)
      + state.index * state.metadata.stepSeconds * 1000).toISOString());
    const reference = dayMode ? day?.referenceIndex : state.referenceIndex;
    dayRange.updateReference({ value: reference, visible: state.opened && (!dayMode || dayReady) && Number.isFinite(reference),
      label: dayMode ? 'Вернуться к текущему времени' : 'К текущему времени · шаг 10 минут',
      active: dayMode ? Boolean(day?.live) : reference !== null && reference === state.displayedIndex });
    const pending = displayStatus === 'loading';
    const waitingForMoment = state.opened && !dayMode && pending && state.metadata;
    if (!waitingForMoment) {
      if (momentLoading) clearTimeout(momentLoading.timer);
      momentLoading = null;
    } else if (!momentLoading) {
      // Continuous scrubbing shares one wait; only the message is delayed.
      const episode = { visible: false, timer: null };
      momentLoading = episode;
      episode.timer = setTimeout(() => {
        if (momentLoading !== episode) return;
        const current = explorer.state;
        if (!current.opened || current.mode !== 'archive' || current.status !== 'loading') return;
        episode.visible = true;
        if (!inputError && !waitingForMetadata) setText(status, 'Загружаем момент…');
      }, 400);
    }
    const unshown = !dayMode && Boolean(state.metadata && state.index !== state.displayedIndex);
    const dayLabel = dayMode && day?.timeline && formatTimelineMinute(day.timeline, day.index ?? 0);
    const selectedLabel = dayLabel ? `${dayLabel.date}, ${dayLabel.time}, ${dayLabel.offset}`
      : requested ? `${requested.date}, ${requested.time} UTC` : '';
    range.setAttribute('aria-valuetext', [selectedLabel, pending ? 'загружается' : unshown ? 'не показано' : '',
      unshown && shown ? `на карте ${shown.date}, ${shown.time} ${shown.zone}` : ''].filter(Boolean).join('; '));
    const momentMessage = momentLoading?.visible ? 'Загружаем момент…' : '';
    setText(status, inputError || (displayStatus === 'error' ? dayMode && day?.status === 'error'
      ? day.error || 'День не загрузился' : state.error || 'Не удалось загрузить момент'
      : waitingForMetadata ? 'Загружаем диапазон дат…'
      : pending ? dayMode ? 'Загружаем день…' : state.metadata ? momentMessage : 'Загружаем шкалу…' : ''));
    if (retryButton) {
      retryButton.hidden = displayStatus !== 'error' || Boolean(inputError);
      retryButton.disabled = pending;
    }
    options.onStateChange?.(state);
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
    inputError = '';
    for (const input of inputs) input.setAttribute('aria-invalid', 'false');
  }
  function applyDates(reportIncomplete = true) {
    if (!explorer.state.opened) return;
    clearInputError();
    let from, through;
    try {
      for (const input of inputs) {
        if (input.value.replace(/\D/g, '').length > 8) {
          input.setAttribute('aria-invalid', 'true');
          throw new Error('В дате должно быть восемь цифр.');
        }
      }
      if (!reportIncomplete && !/^\d{2}\.\d{2}\.\d{4}$/.test(toDate.value)) { update(explorer.state); return; }
      for (const input of inputs) {
        try { normalizeDate(input.value); }
        catch (error) { input.setAttribute('aria-invalid', 'true'); throw error; }
      }
      from = normalizeDate(fromDate.value); through = normalizeDate(toDate.value);
      if (from > through) throw new Error('Начальная дата должна быть не позже конечной.');
      const { minDate, maxDate } = explorer.state;
      if (minDate && from < minDate || maxDate && through > maxDate) {
        throw new Error(`Даты: ${formatDateInput(minDate)}–${formatDateInput(maxDate)}.`);
      }
    } catch (error) {
      inputError = error.message;
      update(explorer.state);
      return;
    }
    submitted = { from, to: through, fromText: fromDate.value, toText: toDate.value };
    const result = explorer.setDateRange(from, through);
    if (result === false) {
      if (!explorer.state.metadata) waitingForMetadata = true;
      else inputError = 'Проверьте выбранный диапазон дат.';
    }
    update(explorer.state);
    Promise.resolve(result).catch(error => { inputError = error.message || 'Проверьте даты.'; update(explorer.state); });
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
        input.setAttribute('aria-invalid', 'true');
        inputError = 'В дате должно быть восемь цифр.';
        update(explorer.state);
        return;
      }
      // Editing the left date never commits the prefilled right date. The
      // complete right date, Enter, or its change event commits the pair.
      if (input === toDate) applyDates(false);
      else update(explorer.state);
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
    toggle.hidden = !enabled || !available;
  };
  // Readiness and the real-clock marker can change without a new chart object.
  // The existing day controller remains the sole owner of its minute range.
  explorer.refreshDay = () => {
    const state = explorer.state;
    if (state.opened && state.mode === 'day') update(state);
  };
  toggle.addEventListener('click', () => enabled && available ? explorer.toggle() : undefined);
  retryButton?.addEventListener('click', () => explorer.state.mode === 'day' && options.getDayState?.()?.status === 'error'
    ? onDayNow() : explorer.retry());
  for (const [input, button] of [[fromDate, fromCalendar], [toDate, toCalendar]]) {
    if (!button) continue;
    calendars.push(attachDatePicker({ input, button,
      getBounds: () => ({ min: explorer.state.minDate, max: explorer.state.maxDate }),
      onSelect(value) {
        input.value = formatDateInput(value); dirty.add(input);
        waitingForMetadata = false; submitted = null; applyDates();
      },
    }));
  }
  update(explorer.state);
  return explorer;
}
