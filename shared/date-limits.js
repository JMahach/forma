// Literal policy values are also read by server/python/date_limits.py.
// Changing creation limits must never narrow ordinary transit/return data.
export const EPHEMERIS_FIRST_YEAR = 1801;
export const EPHEMERIS_LAST_YEAR = 2399;
export const LIFE_SPAN_YEARS = 100;

export const SUPPORTED_START = Date.UTC(EPHEMERIS_FIRST_YEAR, 0, 1);
export const SUPPORTED_END_EXCLUSIVE = Date.UTC(EPHEMERIS_LAST_YEAR + 1, 0, 1);
export const NATAL_LAST_YEAR = EPHEMERIS_LAST_YEAR - LIFE_SPAN_YEARS;
export const NATAL_DATE_MESSAGE = `Натальные карты доступны с ${EPHEMERIS_FIRST_YEAR} по ${NATAL_LAST_YEAR} год: впереди нужны полные ${LIFE_SPAN_YEARS} лет данных.`;

// Keep the birth's UTC clock time; February 29 becomes March 1 when needed.
export function calendarAnniversaryUtc(milliseconds, years = LIFE_SPAN_YEARS) {
  if (!Number.isFinite(milliseconds)) return NaN;
  const birth = new Date(milliseconds), year = birth.getUTCFullYear() + years, month = birth.getUTCMonth();
  return Date.UTC(year, month, birth.getUTCDate(), birth.getUTCHours(), birth.getUTCMinutes(), birth.getUTCSeconds(), birth.getUTCMilliseconds());
}

// The form already validated the calendar date. UTC coverage is checked after
// the server resolves the city's timezone, including historical offsets/folds.
export function natalDateAllowed(date) {
  return typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date)
    && date >= `${EPHEMERIS_FIRST_YEAR}-01-01` && date <= `${NATAL_LAST_YEAR}-12-31`;
}
