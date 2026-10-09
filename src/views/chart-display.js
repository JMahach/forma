import { primaryChart, isChartOverlay } from '../domain/chart-composition.js';
import { cycleEventLabel } from '../domain/cycles.js';
import { ageText, completedAge } from '../domain/personal-age.js';

export const canManageChart = value => {
  const chart = primaryChart(value);
  return chart && chart.id !== 'current-transit' && chart.source !== 'transit';
};
export const chartTitle = value => {
  const chart = primaryChart(value);
  if (isChartOverlay(value)) return `${chart.name?.trim() || 'Личная карта'} · ${value.kind === 'return' ? cycleEventLabel(value.event) : 'Транзит'}`;
  return chart.id === 'current-transit' || chart.source === 'transit' ? 'Транзит' : chart.name;
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
export function savedBirthTime(chart) {
  const seconds = storedOffsetSeconds(chart);
  const utc = Date.parse(chart?.utc);
  if (seconds === null || !Number.isFinite(utc)) return chart?.birthTime || '';
  const clock = new Date(utc + seconds * 1000).toISOString().slice(11, 19);
  return clock.endsWith(':00') && (chart.birthTime || '').length <= 5 ? clock.slice(0, 5) : clock;
}
export const chartSubtitle = (value, { useUtc } = {}) => {
  const chart = primaryChart(value);
  if (isChartOverlay(value)) return momentLabel(value.utc, chart.timezone || 'UTC', value.kind === 'return');
  if (chart.id === 'current-transit' || chart.source === 'transit') return momentLabel(chart.utc, (useUtc ?? chart.id === 'lifetime-preview') ? 'UTC' : null);
  const birth = chart.birthDate && new Date(`${chart.birthDate}T00:00:00Z`);
  const date = birth && Number.isFinite(birth.getTime()) ? formats('UTC').date.format(birth) : '';
  const offset = storedOffsetSeconds(chart);
  const zone = offset !== null ? offsetLabel(offset) : chart.utcOffset || (chart.timezone && Number.isFinite(Date.parse(chart.utc))
    ? momentLabel(chart.utc, chart.timezone).split(' · ').at(-1) : chart.timezone);
  return [date, savedBirthTime(chart), zone, chart.birthPlace].filter(Boolean).join(' · ');
};

// A personal timeline is a preview owned by the selected natal chart. Its
// calculation uses transit data, but navigation and the header retain identity.
export function chartCaption(chart, owner = chart, options) {
  const personalMoment = isChartOverlay(chart);
  const natal = personalMoment ? chart.primary : owner;
  const subtitle = personalMoment ? momentLabel(chart.utc, natal.timezone || 'UTC', chart.kind === 'return') : chartSubtitle(chart, options);
  // The natal caption uses today's age regardless of the open rail; a personal
  // preview or overlay always keeps the age of its displayed moment.
  const ageUtc = personalMoment ? chart.utc : options?.ageUtc ?? chart.utc;
  const age = personalMoment || options?.showAge ? completedAge(ageUtc, primaryChart(natal)) : null;
  return { title: chartTitle(chart), subtitle: [subtitle, subtitle && age !== null ? ageText(age).replace(' ', '\u00a0') : ''].filter(Boolean).join(' · ') };
}
