export type LocalDayTimeline = ReturnType<typeof createLocalDayTimeline>;
interface TimelineMinuteLabel { date: string; time: string; offset: string; utc: string }
const MINUTE = 60_000;
const formatters = new Map<string, Intl.DateTimeFormat>();
const labelFormatters = new Map<string, { time: Intl.DateTimeFormat; date: Intl.DateTimeFormat }>();

const dateFormatter = (timeZone: string) => {
  if (!formatters.has(timeZone)) formatters.set(timeZone, new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }));
  return formatters.get(timeZone)!;
};

export function localDateAt(utc: number | string, timeZone: string) {
  const parts = Object.fromEntries(dateFormatter(timeZone).formatToParts(new Date(utc)).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

// Find the first sample on the requested UTC grid belonging to this date.
function firstSampleOfDate(date: string, timeZone: string, resolution: number) {
  if (timeZone === 'UTC') return Date.parse(`${date}T00:00:00Z`);
  const midnight = Date.parse(`${date}T00:00:00Z`) / resolution;
  let low = midnight - 36 * 3600000 / resolution, high = midnight + 36 * 3600000 / resolution;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (localDateAt(middle * resolution, timeZone) < date) low = middle + 1;
    else high = middle;
  }
  return low * resolution;
}

// Exact calendar boundaries retain historical offsets with seconds.
export function startOfLocalDate(date: string, timeZone: string) {
  return firstSampleOfDate(date, timeZone, 1);
}

// Search actual UTC minutes, rather than assuming every local day lasts 24h.
// Local calendar dates are ordered even when a clock repeats or skips an hour.
function firstMinuteOfDate(date: string, timeZone: string) {
  return firstSampleOfDate(date, timeZone, MINUTE);
}

export function createLocalDayTimeline(utc: number | string, timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone) {
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

export const timelineIndexAt = (timeline: LocalDayTimeline, utc: number) => Math.max(0, Math.min(timeline.minutes - 1, Math.floor((utc - timeline.startUtc) / MINUTE)));

export function timelineMinute(timeline: Pick<LocalDayTimeline, 'startUtc' | 'minutes'>, index: number) {
  const bounded = Math.max(0, Math.min(timeline.minutes - 1, Math.trunc(index)));
  const utc = timeline.startUtc + bounded * MINUTE;
  const date = new Date(utc).toISOString().slice(0, 10);
  return { index: bounded, utc, date, packetIndex: (utc - Date.parse(`${date}T00:00:00Z`)) / MINUTE };
}

// Several views can label the same exact moment in one update. Keep only the
// latest label, and return a copy so a caller cannot change another view's text.
let previousLabelUtc: number | undefined, previousLabelZone: string | undefined, previousLabel: TimelineMinuteLabel | undefined;
export function formatTimelineMinute(timeline: Pick<LocalDayTimeline, 'startUtc' | 'minutes' | 'timeZone'>, index: number): TimelineMinuteLabel {
  const { utc } = timelineMinute(timeline, index);
  if (utc === previousLabelUtc && timeline.timeZone === previousLabelZone) return { ...previousLabel! };
  const date = new Date(utc);
  if (!labelFormatters.has(timeline.timeZone)) labelFormatters.set(timeline.timeZone, {
    time: new Intl.DateTimeFormat('ru-RU', { timeZone: timeline.timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZoneName: 'shortOffset' }),
    date: new Intl.DateTimeFormat('ru-RU', { timeZone: timeline.timeZone, day: 'numeric', month: 'long' }),
  });
  const format = labelFormatters.get(timeline.timeZone)!;
  const parts = format.time.formatToParts(date);
  const value = (type: string) => parts.find(part => part.type === type)?.value || '';
  const label = {
    date: format.date.format(date),
    time: `${value('hour')}:${value('minute')}`,
    offset: value('timeZoneName').replace('GMT', 'UTC'),
    utc: date.toISOString(),
  };
  previousLabelUtc = utc; previousLabelZone = timeline.timeZone; previousLabel = label;
  return { ...label };
}
