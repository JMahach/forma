import { isChartOverlay } from '../domain/chart-composition.js';
import { cycleEventLabel } from '../domain/cycles.js';
import { ageText, completedAge } from '../domain/personal-age.js';

export const canManageLibraryRecord = record => Boolean(record?.id && record.id !== 'current-transit' && record.source !== 'transit');
const isTransit = composition => composition.id === 'current-transit' || composition.primary.source === 'transit';
export const chartTitle = (composition, record = null) => {
  const label = record?.name ?? composition.primaryLabel;
  if (isChartOverlay(composition)) return `${label?.trim() || 'Личная карта'} · ${composition.kind === 'return' ? cycleEventLabel(composition.event) : 'Транзит'}`;
  return isTransit(composition) ? 'Транзит' : label;
};
const formatters = new Map();
function formats(timeZone) {
  if (formatters.has(timeZone)) return formatters.get(timeZone);
  let result;
  try {
    result = {
      date: new Intl.DateTimeFormat('ru-RU', { timeZone, day: 'numeric', month: 'long', year: 'numeric' }),
      clock: new Intl.DateTimeFormat('ru-RU', { timeZone, hour: '2-digit', minute: '2-digit', second: '2-digit', timeZoneName: 'shortOffset' }),
    };
  } catch { result = formats('UTC'); }
  if (formatters.size >= 8) formatters.delete(formatters.keys().next().value);
  formatters.set(timeZone, result); return result;
}
function offsetLabel(seconds) {
  if (!seconds) return 'UTC';
  const value = Math.abs(seconds), minutes = Math.floor(value / 60) % 60, rest = value % 60;
  return `UTC${seconds < 0 ? '-' : '+'}${Math.floor(value / 3600)}`
    + (minutes || rest ? `:${String(minutes).padStart(2, '0')}` : '')
    + (rest ? `:${String(rest).padStart(2, '0')}` : '');
}
function momentLabel(utc, timeZone = null, exact = false) {
  if (typeof utc !== 'string' || !utc.trim() || !Number.isFinite(Date.parse(utc))) return '';
  const date = new Date(utc), local = new Date(date);
  // A cached local Intl formatter would retain the old device timezone. Read
  // local calendar fields anew and print them with the shared UTC formatter.
  if (!timeZone) {
    local.setUTCFullYear(date.getFullYear(), date.getMonth(), date.getDate());
    local.setUTCHours(date.getHours(), date.getMinutes(), date.getSeconds(), date.getMilliseconds());
  }
  const format = formats(timeZone || 'UTC'), parts = format.clock.formatToParts(local);
  const part = type => parts.find(value => value.type === type)?.value || '';
  const clock = `${part('hour')}:${part('minute')}` + (exact && part('second') !== '00' ? `:${part('second')}` : '');
  const zone = timeZone ? part('timeZoneName').replace('GMT', 'UTC').replace(/^UTC[+-]0$/, 'UTC') : offsetLabel((local - date) / 1000);
  return [format.date.format(local), clock, zone].join(' · ');
}

// An exact saved birth may include seconds or the second occurrence of a local
// clock time. Its stored UTC offset preserves that choice in both header and rail.
function storedOffsetSeconds(chart) {
  const offset = /^(?:UTC)?([+−-])(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(chart?.utcOffset || '');
  return offset ? (Number(offset[2]) * 3600 + Number(offset[3]) * 60 + Number(offset[4] || 0)) * (offset[1] === '+' ? 1 : -1) : null;
}
function localTime(chart, recordedTime) {
  const seconds = storedOffsetSeconds(chart);
  const utc = Date.parse(chart?.utc);
  if (seconds === null || !Number.isFinite(utc)) return recordedTime || '';
  const clock = new Date(utc + seconds * 1000).toISOString().slice(11, 19);
  return clock.endsWith(':00') && (recordedTime || '').length <= 5 ? clock.slice(0, 5) : clock;
}
export function savedBirthTime(record) {
  return localTime(record, record?.birthTime);
}
export const chartSubtitle = (composition, record = null, { useUtc } = {}) => {
  const chart = composition.primary;
  if (isChartOverlay(composition)) return momentLabel(composition.utc, record?.timezone || chart.timezone || 'UTC', composition.kind === 'return');
  if (isTransit(composition)) return momentLabel(chart.utc, useUtc ? 'UTC' : null);
  const localDate = chart.localDate && new Date(`${chart.localDate}T00:00:00Z`);
  const date = localDate && Number.isFinite(localDate.getTime()) ? formats('UTC').date.format(localDate) : '';
  const offset = storedOffsetSeconds(chart);
  const zone = offset !== null ? offsetLabel(offset) : chart.utcOffset || (chart.timezone && Number.isFinite(Date.parse(chart.utc))
    ? momentLabel(chart.utc, chart.timezone).split(' · ').at(-1) : chart.timezone);
  return [date, localTime(chart, chart.localTime), zone, record?.birthPlace].filter(Boolean).join(' · ');
};

// A personal timeline is a preview owned by the selected natal chart. Its
// calculation uses transit data, but navigation and the header retain identity.
export function chartCaption(composition, record = null, options) {
  const personalMoment = isChartOverlay(composition);
  const subtitle = chartSubtitle(composition, record, options);
  // The natal caption uses today's age regardless of the open rail; a personal
  // preview or overlay always keeps the age of its displayed moment.
  const ageUtc = personalMoment ? composition.utc : options?.ageUtc ?? composition.utc;
  const age = personalMoment || options?.showAge && !isTransit(composition) ? completedAge(ageUtc, record) : null;
  return { title: chartTitle(composition, record), subtitle: [subtitle, subtitle && age !== null ? ageText(age).replace(' ', '\u00a0') : ''].filter(Boolean).join(' · ') };
}
