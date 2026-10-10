import { calendarTimelineTicks } from '../domain/timeline-ticks.js';
import { lifeDecadeMarks } from '../domain/personal-age.js';

// One owner replaces a rail's decorations and retains its current mode. Changing
// between hours and years never needs a separate clearing pass from another view.
export function attachTimelineMarks(container) {
  let previousMode, previousKey, calendarInputs = null, width = null;
  function renderCalendar() {
    if (!calendarInputs || !container) return;
    const { fromUtc, toUtc, timeZone = 'UTC', labels = false } = calendarInputs;
    const key = JSON.stringify([fromUtc, toUtc, timeZone, labels, width]);
    render('calendar', key, () => {
      const ticks = calendarTimelineTicks({ fromUtc, toUtc, timeZone, width });
      const captions = labels ? calendarCaptions(ticks, { fromUtc, toUtc, timeZone, width, container }) : new Map();
      return ticks.map((tick, index) => {
        const mark = container.ownerDocument.createElement('span');
        mark.className = `calendar-time-mark${tick.edge ? ' is-edge' : ''}`;
        if (tick.edge) mark.dataset.edge = tick.edge;
        mark.style.setProperty('--hour-position', `${tick.position * 100}%`);
        if (captions.has(index)) {
          const label = container.ownerDocument.createElement('span');
          label.textContent = captions.get(index); mark.append(label);
        }
        return mark;
      });
    });
  }
  const Observer = container?.ownerDocument.defaultView?.ResizeObserver || globalThis.ResizeObserver;
  if (container && Observer) new Observer(entries => {
    const measured = entries.find(entry => entry.target === container)?.contentRect?.width;
    if (!Number.isFinite(measured) || measured === width) return;
    width = Math.max(0, measured); renderCalendar();
  }).observe(container);
  function render(mode, key, createMarks) {
    if (!container || mode === previousMode && key === previousKey) return;
    previousMode = mode; previousKey = key;
    container.replaceChildren(...createMarks());
  }
  function clear() { calendarInputs = null; render('empty', null, () => []); }
  return {
    clear,
    calendar(inputs) {
      calendarInputs = inputs;
      if (width === null) width = Math.max(0, container?.getBoundingClientRect?.().width || 0);
      renderCalendar();
    },
    day(day, samples, timeAt) {
      calendarInputs = null;
      if (!day || !(samples > 1)) { clear(); return; }
      render('day', day, () => {
        const marks = [];
        function add(hour, position) {
          const mark = container.ownerDocument.createElement('span');
          const label = container.ownerDocument.createElement('span');
          const major = hour % 6 === 0;
          mark.className = `day-hour-mark${major ? ' is-major' : ''}`;
          mark.style.setProperty('--hour-position', `${position}%`);
          label.textContent = major ? String(hour).padStart(2, '0') : '';
          mark.append(label); marks.push(mark);
        }
        // The day owner supplies actual local minutes, including repeated or
        // missing hours. Scrubbing the same day reuses all existing marks.
        for (let index = 0; index < samples; index++) {
          const time = timeAt(day, index);
          if (time.slice(3, 5) === '00') add(Number(time.slice(0, 2)), index / (samples - 1) * 100);
        }
        // 24 labels the boundary; the selectable range ends at the last minute.
        add(24, 100);
        return marks;
      });
    },
    life(natal, fromUtc, toUtc) {
      calendarInputs = null;
      if (!natal) { clear(); return; }
      const key = JSON.stringify([natal.utc, natal.timezone, fromUtc, toUtc]);
      render('life', key, () => lifeDecadeMarks(natal, fromUtc, toUtc).map(({ age, utc }) => {
        const mark = container.ownerDocument.createElement('span');
        mark.className = `life-year-mark${age % 20 === 0 ? ' is-major' : ''}`;
        mark.dataset.age = String(age);
        mark.style.setProperty('--hour-position', `${(utc - fromUtc) / (toUtc - fromUtc) * 100}%`);
        return mark;
      }));
    },
  };
}

// Dates already live in the From/To fields. The rail names one regular
// calendar grid; captions may skip an equal number of ticks when space is tight.
function calendarCaptions(ticks, { fromUtc, toUtc, timeZone, width, container }) {
  const captions = new Map();
  if (!ticks.length) return captions;
  const calendar = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
  const months = new Intl.DateTimeFormat('ru-RU', { timeZone, month: 'short' });
  const hours = new Intl.DateTimeFormat('ru-RU', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const context = container.ownerDocument.createElement('canvas').getContext?.('2d');
  if (context) context.font = container.ownerDocument.defaultView.getComputedStyle(container).font || '10px sans-serif';
  const measure = text => context ? context.measureText(text).width : text.length * 6;
  const dateParts = utc => Object.fromEntries(calendar.formatToParts(utc).map(part => [part.type, part.value]));
  const firstDate = dateParts(fromUtc);
  const candidates = ticks.flatMap((tick, index) => {
    const { year, month, day } = dateParts(tick.utc), { gridIndex } = tick;
    if (!Number.isInteger(gridIndex)) return [];
    let label;
    if (tick.unit === 'year') {
      label = year;
    } else if (tick.unit === 'month') {
      label = months.format(tick.utc).replace(/\.$/, '');
    } else if (tick.unit === 'day') {
      label = `${day}.${month}`;
    } else {
      label = hours.format(tick.utc);
    }
    const size = measure(label), x = tick.position * width;
    const left = tick.edge === 'start' ? 0 : tick.edge === 'end' ? width - size : x - size / 2;
    if (left < 0 || left + size > width) return [];
    return [{ index, gridIndex, label, left, right: left + size }];
  });
  for (let stride = 1; stride <= 32; stride++) {
    const row = candidates.filter(candidate => candidate.gridIndex % stride === 0);
    if (!row.length || row.length > 8 || row.some((item, index) => index && item.left < row[index - 1].right + 14)) continue;
    for (const item of row) captions.set(item.index, item.label);
    return captions;
  }
  // With no room for a regular row, retain one real landmark. A sub-hour
  // interval with no calendar tick uses its exact starting time instead.
  if (candidates.length) {
    const middle = candidates.reduce((best, item) => Math.abs((item.left + item.right) / 2 - width / 2)
      < Math.abs((best.left + best.right) / 2 - width / 2) ? item : best);
    captions.set(middle.index, middle.label);
  } else {
    const label = toUtc - fromUtc < 86400000 ? hours.format(fromUtc) : `${firstDate.day}.${firstDate.month}`;
    if (measure(label) <= width) captions.set(0, label);
  }
  return captions;
}
