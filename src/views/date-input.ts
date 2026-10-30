const digits = (value: unknown, limit: number) => String(value ?? '').replace(/\D/g, '').slice(0, limit);

// Separators finish a component without adding digits the user did not enter.
// Unseparated digits keep the familiar DDMMYYYY / HHMM entry path.
function formatParts(value: unknown, lengths: readonly number[], separator: string) {
  const source = String(value ?? '').replace(/^\D+/, '');
  const parts = source.split(/\D+/);
  if (parts.length > 1 && parts[0].length <= lengths[0]) {
    const completed = parts.slice(0, -1);
    if (completed.every((part, index) => index >= lengths.length || part.length <= lengths[index])) {
      const result = completed.slice(0, lengths.length).map((part, index) => part.slice(0, lengths[index]));
      let remaining = parts.at(-1)!;
      for (let index = completed.length; index < lengths.length; index += 1) {
        if (!remaining && index > completed.length) break;
        result.push(remaining.slice(0, lengths[index]));
        remaining = remaining.slice(lengths[index]);
      }
      return result.join(separator);
    }
  }
  const text = digits(source, lengths.reduce((sum, length) => sum + length, 0));
  let offset = 0;
  return lengths.map(length => { const part = text.slice(offset, offset + length); offset += length; return part; }).filter(Boolean).join(separator);
}

export function formatDateInput(value: unknown) {
  const source = String(value ?? '');
  if (/^\d{4}-\d{2}-\d{2}$/.test(source.trim())) return source.trim().split('-').reverse().join('.');
  return formatParts(source, [2, 2, 4], '.');
}

// Native caret placement jumps to the start/end above/below an input's text.
// Resolve a date component from X using the actual font, padding and scroll.
export function datePartAt(input: HTMLInputElement, clientX: number | undefined) {
  const parts = [...input.value.matchAll(/\d+/g)];
  if (!parts.length) return null;
  if (!Number.isFinite(clientX) || parts.length === 1) {
    return parts.find(part => input.selectionStart! <= part.index + part[0].length) || parts.at(-1);
  }
  const document = input.ownerDocument, style = document.defaultView!.getComputedStyle(input);
  const scale = input.getBoundingClientRect().width / input.offsetWidth;
  const x = (clientX! - input.getBoundingClientRect().left) / scale - input.clientLeft - parseFloat(style.paddingLeft) + input.scrollLeft;
  const text = document.createElement('span');
  text.style.cssText = 'position:fixed;left:0;top:0;visibility:hidden;pointer-events:none;white-space:pre';
  text.setAttribute('aria-hidden', 'true');
  for (const property of ['fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'fontStretch', 'fontVariant',
    'fontVariantNumeric', 'fontFeatureSettings', 'fontVariationSettings', 'letterSpacing'] as const) text.style[property] = style[property];
  text.textContent = input.value;
  document.body.append(text);
  try {
    const range = document.createRange();
    range.setStart(text.firstChild!, 0);
    const widthTo = (end: number) => { range.setEnd(text.firstChild!, end); return range.getBoundingClientRect().width; };
    for (let index = 0; index < parts.length - 1; index++) {
      const end = parts[index].index + parts[index][0].length;
      const boundary = (widthTo(end) + widthTo(parts[index + 1].index)) / 2;
      if (x <= boundary) return parts[index];
    }
    return parts.at(-1);
  } finally { text.remove(); }
}

export function formatTimeInput(value: unknown) {
  return formatParts(value, [2, 2], ":");
}

export function normalizeDate(value: unknown) {
  const formatted = formatDateInput(value);
  if (!/^\d{2}\.\d{2}\.\d{4}$/.test(formatted)) throw new Error('Введите дату полностью: день, месяц и четыре цифры года.');
  const [day, month, year] = formatted.split('.').map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > days[month - 1]) throw new Error('Проверьте дату: такого дня нет в календаре.');
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export function normalizeTime(value: unknown) {
  const formatted = formatTimeInput(value);
  if (!/^\d{2}:\d{2}$/.test(formatted)) throw new Error('Введите время полностью: часы и минуты.');
  const [hour, minute] = formatted.split(':').map(Number);
  if (hour > 23 || minute > 59) throw new Error('Время должно быть от 00:00 до 23:59.');
  return formatted;
}

export function bindNumericInput(input: HTMLInputElement, format: (value: string) => string, signal?:AbortSignal) {
  function update(value: string, precedingDigits: number) {
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
    const cursor = input.selectionStart!;
    if (event.inputType !== 'deleteContentBackward' || cursor !== input.selectionEnd || cursor < 2 || /\d/.test(input.value[cursor - 1])) return;
    event.preventDefault();
    const value = input.value.slice(0, cursor - 2) + input.value.slice(cursor);
    update(value, digits(input.value.slice(0, cursor - 2), 8).length);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }, {signal});
  input.addEventListener('input', () => {
    const raw = input.value, caret = input.selectionStart!;
    const prefix = raw.slice(0, caret);
    const precedingDigits = digits(format(prefix), 8).length;
    update(raw, precedingDigits);
    if (caret === raw.length) input.setSelectionRange(input.value.length, input.value.length);
    else if (/\D$/.test(prefix) && /\D/.test(input.value[input.selectionStart!] || '')) {
      input.setSelectionRange(input.selectionStart! + 1, input.selectionStart! + 1);
    }
  }, {signal});
}
