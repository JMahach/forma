import { formatDateInput, normalizeDate } from './date-input.js';

const MONTHS = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];
const WEEKDAYS = ['Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота', 'Воскресенье'];
const isoDate = (year, month = 1, day = 1) => `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const PAGE_YEARS = 25;

// A non-modal calendar: typed input remains independent, and Tab can leave the
// popup. Only its active grid choice is tabbable; arrows move between choices.
export function attachDatePicker({ input, button, getBounds, onSelect, precision = 'day', clearLabel = '', onClear = null, getInitialDate = () => null, presentation = null }) {
  const document = input.ownerDocument, window = document.defaultView;
  const popup = document.createElement('section');
  popup.className = ['date-picker', presentation?.className].filter(Boolean).join(' ');
  popup.id = `${input.id}-calendar`; popup.hidden = true;
  popup.setAttribute('role', 'dialog');
  popup.setAttribute('aria-label', input.getAttribute('aria-label') || 'Выбор даты');
  button.setAttribute('aria-haspopup', 'dialog'); button.setAttribute('aria-controls', popup.id); button.setAttribute('aria-expanded', 'false');
  document.body.append(popup);
  let view = 'years', selected = '', cursor = '', pending = '', year = 0, month = 1, page = 0, minimum = '', maximum = '';
  let choices = [], positions = [], columns = 5, firstHeader = null;
  const minYear = () => Number(minimum.slice(0, 4)), maxYear = () => Number(maximum.slice(0, 4));
  const pageFor = value => minYear() + Math.floor((value - minYear()) / PAGE_YEARS) * PAGE_YEARS;
  const allowed = value => value >= minimum && value <= maximum;
  const overlaps = (start, end) => start <= maximum && end >= minimum;
  const bounded = value => value < minimum ? minimum : value > maximum ? maximum : value;
  const lastDay = (year, month) => new Date(Date.UTC(year, month, 0)).getUTCDate();
  function node(tag, text, className) {
    const result = document.createElement(tag);
    if (text) result.textContent = text;
    if (className) result.className = className;
    return result;
  }
  function control(text, label, action, className = '') {
    const result = node('button', text, className); result.type = 'button';
    result.setAttribute('aria-label', label); result.addEventListener('click', action);
    return result;
  }
  function position() {
    if (popup.hidden) return;
    const anchor = button.getBoundingClientRect();
    const viewport = window.visualViewport;
    const left = viewport?.offsetLeft || 0, top = viewport?.offsetTop || 0;
    const width = viewport?.width || window.innerWidth, height = viewport?.height || window.innerHeight;
    // A containing panel may reserve its header. Selection and keyboard logic
    // stay independent of that optional presentation boundary.
    const bounds = presentation?.getBounds?.();
    const area = { left: Math.max(left + 8, bounds?.left ?? -Infinity),
      top: Math.max(top + 8, bounds?.top ?? -Infinity),
      right: Math.min(left + width - 8, bounds?.right ?? Infinity),
      bottom: Math.min(top + height - 8, bounds?.bottom ?? Infinity) };
    if (bounds) popup.style.maxWidth = `${Math.max(0, area.right - area.left)}px`;
    popup.style.maxHeight = `${Math.max(0, area.bottom - area.top)}px`;
    const box = popup.getBoundingClientRect();
    popup.style.left = `${clamp(bounds ? area.left : anchor.left, area.left, Math.max(area.left, area.right - box.width))}px`;
    const above = anchor.top - box.height - 8;
    const preferredTop = presentation?.preferBelow || above < area.top ? anchor.bottom + 8 : above;
    popup.style.top = `${clamp(preferredTop, area.top, Math.max(area.top, area.bottom - box.height))}px`;
  }
  function close(restoreFocus = false) {
    if (popup.hidden) return;
    popup.hidden = true; button.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', outside, true);
    document.removeEventListener('focusin', focusOutside);
    window.removeEventListener('resize', position); window.removeEventListener('scroll', position, true);
    window.visualViewport?.removeEventListener('resize', position);
    window.visualViewport?.removeEventListener('scroll', position);
    const value = pending; pending = '';
    if (value) onSelect(value);
    if (restoreFocus) button.focus({ preventScroll: true });
  }
  function outside(event) { if (!popup.contains(event.target) && !button.contains(event.target)) close(); }
  function focusOutside(event) { if (!popup.contains(event.target) && !button.contains(event.target)) close(); }
  function choose(value, next) {
    const [chosenYear, chosenMonth] = value.split('-').map(Number);
    if (next) {
      const end = next === 'months' ? isoDate(chosenYear, 12, 31) : isoDate(chosenYear, chosenMonth, lastDay(chosenYear, chosenMonth));
      if (!overlaps(value, end)) return;
      // Keep a browsing cursor without copying the actual selected date. Only dismissal
      // commits the coarse year/month choice; a final day replaces it.
      const previewMonth = next === 'months' ? Number(cursor.slice(5, 7)) : chosenMonth;
      const previewDay = Math.min(Number(cursor.slice(8, 10)), lastDay(chosenYear, previewMonth));
      cursor = bounded(isoDate(chosenYear, previewMonth, previewDay));
      pending = bounded(value); [year, month] = cursor.split('-').map(Number);
      view = next; render();
    } else {
      if (!allowed(value)) return;
      selected = pending = value; close(true);
    }
  }
  function focusChoice(index) {
    const target = choices[clamp(index, 0, choices.length - 1)];
    for (const choice of choices) choice.tabIndex = choice === target ? 0 : -1;
    target?.focus();
  }
  function navigate(direction) {
    if (view === 'years') page = clamp(page + direction * PAGE_YEARS, minYear(), pageFor(maxYear()));
    else if (view === 'months') year = clamp(year + direction, minYear(), maxYear());
    else if (view === 'days') {
      const date = new Date(Date.UTC(year, month - 1 + direction, 1));
      if (!overlaps(isoDate(date.getUTCFullYear(), date.getUTCMonth() + 1), isoDate(date.getUTCFullYear(), date.getUTCMonth() + 1, 31))) return;
      year = date.getUTCFullYear(); month = date.getUTCMonth() + 1;
    }
    render();
  }
  function render() {
    const now = new Date(), currentYear = now.getFullYear();
    const today = isoDate(currentYear, now.getMonth() + 1, now.getDate());
    choices = []; positions = []; popup.replaceChildren(); popup.dataset.view = view;
    const dismiss = control('×', 'Закрыть календарь', () => close(true));
    if (presentation?.title) {
      const heading = node('div', '', 'returns-menu-heading');
      heading.append(node('strong', presentation.title), dismiss); popup.append(heading);
    }
    const header = node('div', '', 'date-picker-heading');
    const previous = control('‹', view === 'years' ? 'Предыдущие годы' : view === 'months' ? 'Предыдущий год' : 'Предыдущий месяц', () => navigate(-1));
    const next = control('›', view === 'years' ? 'Следующие годы' : view === 'months' ? 'Следующий год' : 'Следующий месяц', () => navigate(1));
    const title = view === 'periods' ? 'Выберите период' : view === 'years' ? `${page}–${Math.min(page + PAGE_YEARS - 1, maxYear())}` : view === 'months' ? String(year) : `${MONTHS[month - 1]} ${year}`;
    const heading = control(title, view === 'years' ? `${title}. Выбрать период` : view === 'months' ? `${title}. Выбрать год` : view === 'days' ? `${title}. Выбрать месяц` : title,
      () => { view = view === 'years' ? 'periods' : view === 'days' ? 'months' : 'years'; render(); }, 'date-picker-title');
    heading.setAttribute('aria-live', 'polite');
    previous.hidden = next.hidden = view === 'periods';
    previous.disabled = view === 'years' ? page === minYear() : view === 'months' ? year === minYear() : isoDate(year, month) <= minimum;
    next.disabled = view === 'years' ? page + PAGE_YEARS > maxYear() : view === 'months' ? year === maxYear() : isoDate(year, month, 31) >= maximum;
    firstHeader = presentation?.title ? dismiss : previous.hidden || previous.disabled ? heading : previous;
    header.append(previous, heading, next);
    if (!presentation?.title) header.append(dismiss);
    popup.append(header);
    const grid = node('div', '', 'date-picker-grid'); grid.setAttribute('role', 'grid'); grid.setAttribute('aria-label', title);
    columns = view === 'days' ? 7 : view === 'months' ? 3 : view === 'periods' ? 4 : 5;
    grid.style.setProperty('--calendar-columns', columns);
    let row = null, count = 0, focused = -1;
    function cell(text, label, action, { enabled = true, active = false, preferred = active, current = false, empty = false, weekday = false } = {}) {
      if (count++ % columns === 0) { row = node('div', '', 'date-picker-row'); row.setAttribute('role', 'row'); grid.append(row); }
      const wrapper = node('div'); wrapper.setAttribute('role', weekday ? 'columnheader' : 'gridcell'); row.append(wrapper);
      if (empty || weekday) { wrapper.textContent = text; if (label) wrapper.setAttribute('aria-label', label); return; }
      const choice = control(text, label, action); choice.disabled = !enabled; choice.tabIndex = -1;
      wrapper.setAttribute('aria-selected', String(active));
      if (active) choice.dataset.selected = 'true';
      if (current) choice.setAttribute('aria-current', view === 'days' ? 'date' : 'true');
      wrapper.append(choice);
      if (enabled) { if (preferred) focused = choices.length; choices.push(choice); positions.push(count - 1); }
    }
    if (view === 'periods') {
      for (let start = minYear(); start <= maxYear(); start += PAGE_YEARS) {
        const end = Math.min(start + PAGE_YEARS - 1, maxYear());
        cell(`${start}–${end}`, `Годы ${start}–${end}`, () => { page = start; view = 'years'; render(); },
          { active: Number(selected.slice(0, 4)) >= start && Number(selected.slice(0, 4)) <= end, preferred: year >= start && year <= end, current: currentYear >= start && currentYear <= end });
      }
    } else if (view === 'years') {
      for (let value = page; value <= Math.min(page + PAGE_YEARS - 1, maxYear()); value++) {
        const date = isoDate(value);
        cell(String(value), precision === 'year' ? `${value} год` : `${value} год, 1 января`,
          () => precision === 'year' ? choose(bounded(date)) : choose(date, 'months'),
          { enabled: overlaps(date, isoDate(value, 12, 31)), active: Number(selected.slice(0, 4)) === value, preferred: Number(cursor.slice(0, 4)) === value, current: currentYear === value });
      }
    } else if (view === 'months') {
      MONTHS.forEach((name, index) => {
        const date = isoDate(year, index + 1);
        cell(name, `${name} ${year}, первое число`, () => choose(date, 'days'),
          { enabled: overlaps(date, isoDate(year, index + 1, lastDay(year, index + 1))), active: selected.slice(0, 7) === date.slice(0, 7), preferred: cursor.slice(0, 7) === date.slice(0, 7), current: today.slice(0, 7) === date.slice(0, 7) });
      });
    } else {
      WEEKDAYS.forEach(name => cell(name.slice(0, 2), name, null, { weekday: true }));
      const offset = (new Date(Date.UTC(year, month - 1, 1)).getUTCDay() + 6) % 7;
      for (let blank = 0; blank < offset; blank++) cell('', '', null, { empty: true });
      const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
      for (let day = 1; day <= days; day++) {
        const date = isoDate(year, month, day);
        cell(String(day), formatDateInput(date), () => choose(date), { enabled: allowed(date), active: selected === date, preferred: cursor === date, current: today === date });
      }
    }
    popup.append(grid);
    if (onClear && clearLabel) {
      const footer = node('div', '', `date-picker-footer${presentation?.title ? ' returns-menu-actions' : ''}`);
      footer.append(control(clearLabel, clearLabel, () => { pending = ''; close(true); onClear(); }));
      popup.append(footer);
    }
    position(); focusChoice(focused < 0 ? 0 : focused);
  }
  function open() {
    const bounds = getBounds(); minimum = bounds?.min; maximum = bounds?.max;
    if (!minimum || !maximum || minimum > maximum || button.disabled) return;
    try { selected = precision === 'year'
      ? /^\d{4}$/.test(input.value.trim()) ? isoDate(Number(input.value)) : ''
      : normalizeDate(input.value); } catch { selected = ''; }
    if (selected && !allowed(selected)) selected = '';
    cursor = bounded(selected || getInitialDate() || minimum); pending = '';
    [year, month] = cursor.split('-').map(Number); page = pageFor(year); view = 'years';
    popup.hidden = false; button.setAttribute('aria-expanded', 'true'); render();
    document.addEventListener('pointerdown', outside, true); document.addEventListener('focusin', focusOutside);
    window.addEventListener('resize', position); window.addEventListener('scroll', position, true);
    window.visualViewport?.addEventListener('resize', position);
    window.visualViewport?.addEventListener('scroll', position);
  }
  popup.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); return; }
    const current = choices.indexOf(document.activeElement);
    if (event.key === 'Tab') {
      // The popup follows its trigger logically, even though it is portalled
      // to body to avoid clipping inside the chart's camera surface.
      if (!event.shiftKey && current >= 0 && !onClear) { event.preventDefault(); close(); (input.hidden ? button : input).focus(); }
      else if (event.shiftKey && document.activeElement === firstHeader) { event.preventDefault(); close(true); }
      return;
    }
    if (current < 0) return;
    const moves = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -columns, ArrowDown: columns };
    if (Object.hasOwn(moves, event.key)) { event.preventDefault(); focusChoice(current + moves[event.key]); }
    else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      const row = Math.floor(positions[current] / columns);
      const rowChoices = positions.map((position, index) => Math.floor(position / columns) === row ? index : -1).filter(index => index >= 0);
      focusChoice(event.key === 'Home' ? rowChoices[0] : rowChoices.at(-1));
    } else if ((event.key === 'PageUp' || event.key === 'PageDown') && view !== 'periods') {
      event.preventDefault(); navigate(event.key === 'PageUp' ? -1 : 1);
    }
  });
  button.addEventListener('click', () => popup.hidden ? open() : close());
  return { close, get opened() { return !popup.hidden; } };
}
