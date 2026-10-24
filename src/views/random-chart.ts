const formatter = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Moscow',
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
function civil(milliseconds: number) {
  const parts = Object.fromEntries(formatter.formatToParts(milliseconds).map(part => [part.type, part.value]));
  const date = `${parts.year}-${parts.month}-${parts.day}`, time = `${parts.hour}:${parts.minute}`;
  return { date, time, epoch: Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute)) };
}

// Starting with UTC avoids nonexistent civil times. Around a clock change,
// distinct offsets give the two chronological occurrences used by fold 0/1.
export function moscowBirthAt(instant: Date) {
  const milliseconds = instant.getTime();
  if (!Number.isFinite(milliseconds)) throw new RangeError('Invalid UTC moment');
  const local = civil(milliseconds);
  const offsets = new Set([-2, 0, 2].map(days => {
    const sample = milliseconds + days * 86_400_000;
    return civil(sample).epoch - sample;
  }));
  const candidates = [...offsets].map(offset => local.epoch - offset)
    .filter(candidate => { const value = civil(candidate); return value.date === local.date && value.time === local.time; })
    .sort((a, b) => a - b);
  const fold = candidates.indexOf(milliseconds);
  if (fold !== 0 && fold !== 1) throw new Error('Не удалось определить местное время примера. Повторите попытку.');
  return { date: local.date, time: local.time, name: `Пример ${local.date.split('-').reverse().join('.')}`, utc: instant.toISOString(), fold };
}

// Randomize only a real past calendar minute; all gates come from the server.
export function randomBirthMoment(random = Math.random) {
  // Moscow entered 2006 at 21:00 UTC; exclude that boundary as well.
  const start = Date.UTC(1950, 0, 1), end = Date.UTC(2005, 11, 31, 21);
  const value = random();
  if (!Number.isFinite(value) || value < 0 || value >= 1) throw new RangeError('Random value must be in [0, 1).');
  const instant = new Date(start + Math.floor(value * ((end - start) / 60_000)) * 60_000);
  return moscowBirthAt(instant);
}
