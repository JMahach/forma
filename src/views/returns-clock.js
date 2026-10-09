import { cycleTimeZone } from '../domain/cycles.js';
import { ageText, completedAge } from '../domain/personal-age.js';

const formatters = new Map();
function timezoneFormats(value) {
  const key = cycleTimeZone(value);
  if (formatters.has(key)) return formatters.get(key);
  const create = timeZone => ({
    date: new Intl.DateTimeFormat('ru-RU', { timeZone, day: 'numeric', month: 'long', year: 'numeric' }),
    clock: new Intl.DateTimeFormat('ru-RU', { timeZone, hour: '2-digit', minute: '2-digit' }),
  });
  const result = create(key);
  if (formatters.size >= 8) formatters.delete(formatters.keys().next().value);
  formatters.set(key, result); return result;
}
export function returnMomentDetails(utc, natal) {
  if (!Number.isFinite(Date.parse(utc))) return { utc: '', date: '', time: '', age: '' };
  const formats = timezoneFormats(natal?.timezone), date = new Date(utc);
  const label = formats.date.format(date).replace(/\s*г\.$/, '');
  const clock = formats.clock.format(date);
  return { utc, date: label, time: clock, age: ageText(completedAge(utc, natal)) };
}

// The entry is available before the event drawer is loaded. The main heading
// owns the displayed moment; this control only opens the event list.
export function updateReturnsEntry({ footer, entry }, state) {
  footer.hidden = !state.available || !state.timelineVisible;
  entry.setAttribute('aria-expanded', String(!footer.hidden && state.opened));
}
