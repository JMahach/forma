import { setText } from '../ui/html.js';

const plurals = new Intl.PluralRules('ru');
export const ageText = age => `${age} ${{ one: 'год', few: 'года', many: 'лет', other: 'лет' }[plurals.select(age)]}`;
const formatters = new Map(), birthCalendars = new Map();
function remember(cache, key, value) {
  if (cache.size >= 8) cache.delete(cache.keys().next().value);
  cache.set(key, value); return value;
}
function timezoneFormats(value) {
  const key = typeof value === 'string' && value ? value : 'UTC';
  if (formatters.has(key)) return formatters.get(key);
  let timeZone = key, calendar;
  try { calendar = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }); }
  catch { timeZone = 'UTC'; calendar = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }); }
  return remember(formatters, key, { timeZone, calendar,
    date: new Intl.DateTimeFormat('ru-RU', { timeZone, day: 'numeric', month: 'long', year: 'numeric' }),
    clock: new Intl.DateTimeFormat('ru-RU', { timeZone, hour: '2-digit', minute: '2-digit' }),
  });
}
const zone = natal => timezoneFormats(natal?.timezone).timeZone;
function calendar(utc, timezone) {
  const parts = timezoneFormats(timezone).calendar.formatToParts(new Date(utc));
  return Object.fromEntries(parts.filter(part => ['year', 'month', 'day'].includes(part.type)).map(part => [part.type, Number(part.value)]));
}
function birthCalendar(natal, timezone) {
  const key = `${natal.utc}:${timezone}`;
  return birthCalendars.get(key) || remember(birthCalendars, key, calendar(natal.utc, timezone));
}
export function returnAge(utc, natal) {
  if (!Number.isFinite(Date.parse(utc)) || !Number.isFinite(Date.parse(natal?.utc))) return null;
  const timezone = zone(natal), birth = birthCalendar(natal, timezone), moment = calendar(utc, timezone);
  return Math.max(0, moment.year - birth.year - (moment.month < birth.month || moment.month === birth.month && moment.day < birth.day ? 1 : 0));
}
export function returnFooter(state) {
  const utc = state.selectedEvent?.utc || state.cursorUtc || state.natal?.utc;
  if (!Number.isFinite(Date.parse(utc))) return { utc: '', date: '', detail: '' };
  const formats = timezoneFormats(state.natal?.timezone), date = new Date(utc);
  const label = formats.date.format(date).replace(/\s*г\.$/, '');
  const clock = formats.clock.format(date);
  return { utc, date: label, detail: `${clock} · ${ageText(returnAge(utc, state.natal))}` };
}

// The clock and its entry are available before the event drawer is loaded.
export function updateReturnClock({ footer, entry, date, detail, label }, state) {
  footer.hidden = !state.available || !state.timelineVisible;
  entry.setAttribute('aria-expanded', String(!footer.hidden && state.opened));
  if (footer.hidden) return;
  const clock = returnFooter(state);
  setText(date, clock.date); date.dateTime = clock.utc; date.title = zone(state.natal);
  setText(detail, clock.detail); setText(label, 'Возвраты');
}
