import { primaryChart, isChartOverlay } from '../domain/chart-composition.js';
import { cycleEventLabel } from '../domain/cycles.js';
import { formatDateInput } from './date-input.js';

export const canManageChart = value => {
  const chart = primaryChart(value);
  return chart && chart.id !== 'current-transit' && chart.source !== 'transit';
};
export const chartTitle = value => {
  const chart = primaryChart(value);
  if (isChartOverlay(value)) return `${chart.name?.trim() || 'Личная карта'} · ${value.kind === 'return' ? cycleEventLabel(value.event) : 'Транзит'}`;
  return chart.id === 'current-transit' || chart.source === 'transit' ? 'Транзит' : chart.name;
};
let transitFormatters;
const transitSubtitle = (value, useUtc = false) => {
  if (typeof value !== 'string' || !value.trim()) return '';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  // Both the date and clock describe the displayed calculation, including a
  // paused minute. Never substitute the wall clock for a missing chart moment.
  // Read the current local calendar first. UTC formatters only print those
  // fields: they keep no stale device timezone after an in-page zone change.
  const local = new Date(date);
  if (!useUtc) {
    local.setUTCFullYear(date.getFullYear(), date.getMonth(), date.getDate());
    local.setUTCHours(date.getHours(), date.getMinutes(), date.getSeconds(), date.getMilliseconds());
  }
  transitFormatters ??= [
    new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }),
    new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' }),
  ];
  return transitFormatters.map(formatter => formatter.format(local)).join(' · ') + (useUtc ? ' · UTC' : '');
};
export const chartSubtitle = (value, { useUtc } = {}) => {
  if (isChartOverlay(value)) return transitSubtitle(value.utc, true);
  const chart = primaryChart(value);
  return chart.id === 'current-transit' || chart.source === 'transit' ? transitSubtitle(chart.utc, useUtc ?? chart.id === 'lifetime-preview')
    : [chart.birthDate ? formatDateInput(chart.birthDate) : '', chart.birthTime, chart.birthPlace].filter(Boolean).join(' · ');
};

// A personal timeline is a preview owned by the selected natal chart. Its
// calculation uses transit data, but navigation and the header retain identity.
export function chartCaption(chart, owner = chart, personalPreview = false, options) {
  const identity = personalPreview && !isChartOverlay(chart) && owner?.source !== 'transit' && owner?.id !== 'current-transit' ? owner : chart;
  return { title: chartTitle(identity), subtitle: chartSubtitle(identity, options) };
}
