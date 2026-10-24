// Frequent names in the EGR ZAGS historical register (births since 1926).
// Е/Ё variants are merged, five uncommon spellings omitted, Алмаз added by request.
// This is a fixed example pool, not a ranking of the current population. Sources: README.
export const RANDOM_CHART_NAMES: readonly string[] = Object.freeze([
  "Александр", "Николай", "Владимир", "Сергей", "Татьяна",
  "Валентина", "Алексей", "Елена", "Мария", "Иван",
  "Виктор", "Анна", "Ольга", "Галина", "Михаил",
  "Наталья", "Нина", "Анатолий", "Андрей", "Юрий",
  "Людмила", "Дмитрий", "Светлана", "Ирина", "Екатерина",
  "Надежда", "Василий", "Евгений", "Анастасия", "Любовь",
  "Александра", "Вера", "Юлия", "Валерий", "Лидия",
  "Тамара", "Павел", "Марина", "Максим", "Игорь",
  "Пётр", "Олег", "Вячеслав", "Виктория", "Дарья",
  "Виталий", "Борис", "Роман", "Раиса", "Константин",
  "Зинаида", "Илья", "Денис", "Геннадий", "Леонид",
  "Елизавета", "Евгения", "Артём", "Лариса", "Зоя",
  "Антонина", "Никита", "Валентин", "Ксения", "Кирилл",
  "Оксана", "Владислав", "Егор", "Наталия", "Полина",
  "Клавдия", "Григорий", "Антон", "Алина", "Маргарита",
  "Валерия", "Вадим", "София", "Фёдор", "Евдокия",
  "Руслан", "Даниил", "Кристина", "Георгий", "Варвара",
  "Софья", "Станислав", "Вероника", "Матвей", "Арина",
  "Диана", "Лилия", "Алла", "Степан", "Тимофей",
  "Алёна", "Яна", "Олеся", "Алиса", "Данил",
  "Эдуард", "Ульяна", "Ярослав", "Лев", "Ангелина",
  "Альбина", "Таисия", "Инна", "Артур", "Тимур",
  "Милана", "Аркадий", "Антонида", "Карина", "Роза",
  "Арсений", "Ева", "Семён", "Альберт", "Алевтина",
  "Эльвира", "Марк", "Василиса", "Пелагея", "Кира",
  "Глеб", "Яков", "Жанна", "Римма", "Богдан",
  "Магомед", "Марат", "Фаина", "Данила", "Ираида",
  "Амина", "Прасковья", "Давид", "Мадина", "Рустам",
  "Герман", "Анжелика", "Захар", "Дарина", "Рима",
  "Дина", "Ринат", "Таиса", "Дамир", "Матрёна",
  "Фатима", "Макар", "Патимат", "Амир", "Савелий",
  "Вениамин", "Элина", "Лида", "Серафима", "Шамиль",
  "Марьям", "Эмилия", "Марфа", "Регина", "Ислам",
  "Альфия", "Мухаммад", "Мирон", "Алия", "Злата",
  "Рамиль", "Ильдар", "Мирослава", "Марья", "Аминат",
  "Аделина", "Виолетта", "Роберт", "Гульнара", "Артемий",
  "Майя", "Анжела", "Милена", "Ибрагим", "Рамазан",
  "Димитрий", "Адам", "Эльмира", "Нелли", "Али",
  "Равиль", "Венера", "Эвелина", "Радик", "Ахмед",
  "Есения", "Арсен", "Клара", "Родион", "Алмаз",
]);

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
  return { date: local.date, time: local.time, utc: instant.toISOString(), fold };
}

function randomFraction(random: () => number) {
  const value = random();
  if (!Number.isFinite(value) || value < 0 || value >= 1) throw new RangeError('Random value must be in [0, 1).');
  return value;
}

// Choose name and real past calendar minute independently; gates come from the server.
export function randomBirthMoment(random = Math.random) {
  // Moscow entered 2006 at 21:00 UTC; exclude that boundary as well.
  const start = Date.UTC(1950, 0, 1), end = Date.UTC(2005, 11, 31, 21);
  const value = randomFraction(random);
  const instant = new Date(start + Math.floor(value * ((end - start) / 60_000)) * 60_000);
  const name = RANDOM_CHART_NAMES[Math.floor(randomFraction(random) * RANDOM_CHART_NAMES.length)]!;
  return { ...moscowBirthAt(instant), name };
}
