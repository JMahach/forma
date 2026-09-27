const MINUTE = 60_000;
const formatters = new Map();
const labelFormatters = new Map();

const dateFormatter = timeZone => {
  if (!formatters.has(timeZone)) formatters.set(timeZone, new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }));
  return formatters.get(timeZone);
};

export function localDateAt(utc, timeZone) {
  const parts = Object.fromEntries(dateFormatter(timeZone).formatToParts(new Date(utc)).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

// Search actual UTC minutes, rather than assuming every local day lasts 24h.
// Local calendar dates are ordered even when a clock repeats or skips an hour.
function firstMinuteOfDate(date, timeZone) {
  const midnight = Date.parse(`${date}T00:00:00Z`) / MINUTE;
  let low = midnight - 36 * 60, high = midnight + 36 * 60;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (localDateAt(middle * MINUTE, timeZone) < date) low = middle + 1;
    else high = middle;
  }
  return low * MINUTE;
}

export function createLocalDayTimeline(utc, timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone) {
  const date = localDateAt(utc, timeZone);
  const tomorrow = new Date(Date.parse(`${date}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  const startUtc = firstMinuteOfDate(date, timeZone), endUtc = firstMinuteOfDate(tomorrow, timeZone);
  const minutes = (endUtc - startUtc) / MINUTE;
  const packetDates = [];
  for (let utcDay = Math.floor(startUtc / 86_400_000) * 86_400_000; utcDay < endUtc; utcDay += 86_400_000) {
    packetDates.push(new Date(utcDay).toISOString().slice(0, 10));
  }
  return Object.freeze({ date, timeZone, startUtc, endUtc, minutes, packetDates: Object.freeze(packetDates) });
}

export const timelineIndexAt = (timeline, utc) => Math.max(0, Math.min(timeline.minutes - 1, Math.floor((utc - timeline.startUtc) / MINUTE)));

export function timelineMinute(timeline, index) {
  const bounded = Math.max(0, Math.min(timeline.minutes - 1, Math.trunc(index)));
  const utc = timeline.startUtc + bounded * MINUTE;
  const date = new Date(utc).toISOString().slice(0, 10);
  return { index: bounded, utc, date, packetIndex: (utc - Date.parse(`${date}T00:00:00Z`)) / MINUTE };
}

export function formatTimelineMinute(timeline, index) {
  const { utc } = timelineMinute(timeline, index);
  const date = new Date(utc);
  if (!labelFormatters.has(timeline.timeZone)) labelFormatters.set(timeline.timeZone, {
    time: new Intl.DateTimeFormat('ru-RU', { timeZone: timeline.timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZoneName: 'shortOffset' }),
    date: new Intl.DateTimeFormat('ru-RU', { timeZone: timeline.timeZone, day: 'numeric', month: 'long' }),
  });
  const format = labelFormatters.get(timeline.timeZone);
  const parts = format.time.formatToParts(date);
  const value = type => parts.find(part => part.type === type)?.value || '';
  return {
    date: format.date.format(date),
    time: `${value('hour')}:${value('minute')}`,
    offset: value('timeZoneName').replace('GMT', 'UTC'),
    utc: date.toISOString(),
  };
}
