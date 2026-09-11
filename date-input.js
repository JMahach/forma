const digits = (value, limit) => String(value ?? '').replace(/\D/g, '').slice(0, limit);

export function formatDateInput(value) {
  const source = String(value ?? '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(source)) return source.split('-').reverse().join('.');
  const d = digits(source, 8);
  return [d.slice(0, 2), d.slice(2, 4), d.slice(4, 8)].filter(Boolean).join('.');
}

export function formatTimeInput(value) {
  const source = String(value ?? '').trim();
  if (/^\d:\d{2}$/.test(source)) return `0${source}`;
  const d = digits(source, 4);
  return [d.slice(0, 2), d.slice(2, 4)].filter(Boolean).join(':');
}

export function normalizeDate(value) {
  const formatted = formatDateInput(value);
  if (!/^\d{2}\.\d{2}\.\d{4}$/.test(formatted)) throw new Error('Введите дату полностью: день, месяц и четыре цифры года.');
  const [day, month, year] = formatted.split('.').map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > days[month - 1]) throw new Error('Проверьте дату: такого дня нет в календаре.');
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export function normalizeTime(value) {
  const formatted = formatTimeInput(value);
  if (!/^\d{2}:\d{2}$/.test(formatted)) throw new Error('Введите время полностью: часы и минуты.');
  const [hour, minute] = formatted.split(':').map(Number);
  if (hour > 23 || minute > 59) throw new Error('Время должно быть от 00:00 до 23:59.');
  return formatted;
}

export function bindNumericInput(input, format) {
  function update(value, precedingDigits) {
    input.value = format(value);
    let cursor = input.value.length;
    if (precedingDigits === 0) cursor = 0;
    else {
      let count = 0;
      for (let index = 0; index < input.value.length; index += 1) {
        if (/\d/.test(input.value[index])) count += 1;
        if (count === precedingDigits) { cursor = index + 1; break; }
      }
    }
    input.setSelectionRange(cursor, cursor);
  }
  input.addEventListener('beforeinput', event => {
    const cursor = input.selectionStart;
    if (event.inputType !== 'deleteContentBackward' || cursor !== input.selectionEnd || cursor < 2 || /\d/.test(input.value[cursor - 1])) return;
    event.preventDefault();
    const value = input.value.slice(0, cursor - 2) + input.value.slice(cursor);
    update(value, digits(input.value.slice(0, cursor - 2), 8).length);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  input.addEventListener('input', () => {
    const precedingDigits = digits(input.value.slice(0, input.selectionStart), 8).length;
    update(input.value, precedingDigits);
  });
}
