import test from 'node:test';
import assert from 'node:assert/strict';
import { formatDateInput, formatTimeInput, normalizeDate, bindNumericInput } from '../src/views/date-input.ts';

test('date entry accepts digits or any typed separator, including short day and month', () => {
  for (const value of ['01022000', '01,02,2000', '01/02/2000', '01 02 2000', '01а02б2000', '2000-02-01']) {
    assert.equal(formatDateInput(value), '01.02.2000', value);
    assert.equal(normalizeDate(value), '2000-02-01', value);
  }
  assert.equal(formatDateInput('1,'), '1.');
  assert.equal(formatDateInput('1,2,2000'), '1.2.2000');
  assert.throws(() => normalizeDate('1,2,2000'), /полностью/);
  assert.equal(formatDateInput('01.2,'), '01.2.');
  assert.equal(formatDateInput('31.02.2000'), '31.02.2000');
  assert.throws(() => normalizeDate('31,02,2000'), /календаре/);
  assert.equal(formatTimeInput('7,05'), '7:05');
});

test('separator entry keeps the caret after the separator and backspace remains usable', () => {
  type InputEventFixture = {type?:string;inputType?:string;preventDefault?():void};
  const handlers = new Map<string,(event:InputEventFixture)=>void>();
  const input = { value: '', selectionStart: 0, selectionEnd: 0,
    addEventListener(type:string, handler:(event:InputEventFixture)=>void) { handlers.set(type, handler); },
    setSelectionRange(start:number, end:number) { this.selectionStart = start; this.selectionEnd = end; },
    dispatchEvent(event:Event) { handlers.get(event.type)?.(event); } };
  // The input model deliberately implements only the masking port.
  bindNumericInput(input as unknown as HTMLInputElement, formatDateInput);
  const enter = (value:string) => { input.value = value; input.selectionStart = input.selectionEnd = value.length; handlers.get('input')!({}); };
  enter('1,'); assert.equal(input.value, '1.'); assert.equal(input.selectionStart, 2);
  enter('01.2/'); assert.equal(input.value, '01.2.'); assert.equal(input.selectionStart, 5);
  enter('01.02.2000'); assert.equal(input.selectionStart, 10);
  input.selectionStart = input.selectionEnd = 3;
  let prevented = false;
  handlers.get('beforeinput')!({ inputType: 'deleteContentBackward', preventDefault() { prevented = true; } });
  assert.equal(prevented, true); assert.equal(input.selectionStart, 1);
});

// Exercise every intermediate value produced while typing into an already masked field.
test('sequential typing retains the whole date and time after automatic separators appear', () => {
  const type = (text:string, format:(value:string)=>string) => [...text].reduce((value, character) => format(value + character), '');
  assert.equal(type('01022000', formatDateInput), '01.02.2000');
  assert.equal(type('1,2,2000', formatDateInput), '1.2.2000');
  assert.equal(type('1205', formatTimeInput), '12:05');
  assert.equal(type('7,05', formatTimeInput), '7:05');
});
