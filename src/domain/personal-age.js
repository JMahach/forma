const plurals = new Intl.PluralRules('ru');
export const ageText = age => `${age} ${{ one: 'год', few: 'года', many: 'лет', other: 'лет' }[plurals.select(age)]}`;
const formatters = new Map(), birthCalendars = new Map();
function remember(cache, key, value) {
  if (cache.size >= 8) cache.delete(cache.keys().next().value);
  cache.set(key, value); return value;
}
function calendar(utc, timezone) {
  const key = typeof timezone === 'string' && timezone ? timezone : 'UTC';
  let formatter = formatters.get(key);
  if (!formatter) {
    const options = { year: 'numeric', month: '2-digit', day: '2-digit' };
    try { formatter = new Intl.DateTimeFormat('en-CA', { ...options, timeZone: key }); }
    catch { formatter = new Intl.DateTimeFormat('en-CA', { ...options, timeZone: 'UTC' }); }
    remember(formatters, key, formatter);
  }
  const parts = formatter.formatToParts(new Date(utc));
  return Object.fromEntries(parts.filter(part => ['year', 'month', 'day'].includes(part.type)).map(part => [part.type, Number(part.value)]));
}

// Completed age changes at local midnight on the birthday, not at the birth
// clock time. A 29 February birthday reaches its next age on 1 March otherwise.
export function completedAge(utc, natal) {
  if (!Number.isFinite(Date.parse(utc)) || !Number.isFinite(Date.parse(natal?.utc))) return null;
  const key = `${natal.utc}:${natal.timezone || 'UTC'}`;
  const birth = birthCalendars.get(key) || remember(birthCalendars, key, calendar(natal.utc, natal.timezone));
  const moment = calendar(utc, natal.timezone);
  return Math.max(0, moment.year - birth.year - (moment.month < birth.month || moment.month === birth.month && moment.day < birth.day ? 1 : 0));
}

// Find real age boundaries before clipping them to the visible range. Starting
// the search at the range edge would invent birthdays when a year is filtered.
export function lifeDecadeMarks(natal, fromUtc, toUtc) {
  const birth = Date.parse(natal?.utc);
  if (!Number.isFinite(birth) || !Number.isFinite(fromUtc) || !Number.isFinite(toUtc) || toUtc <= fromUtc || toUtc <= birth) return [];
  const ageAt = utc => completedAge(new Date(utc).toISOString(), natal);
  const lastAge = Math.min(100, ageAt(toUtc)), marks = [];
  for (let age = 10; age <= lastAge; age += 10) {
    let low = birth, high = toUtc;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (ageAt(middle) < age) low = middle + 1;
      else high = middle;
    }
    if (low >= fromUtc) marks.push({ age, utc: low });
  }
  return marks;
}
