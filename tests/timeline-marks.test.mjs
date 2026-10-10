import test from 'node:test';
import assert from 'node:assert/strict';
import { attachTimelineMarks } from '../src/views/timeline-marks.js';
import { dateDom } from './helpers/date-dom.mjs';

function harness(width = 640) {
  const document = dateDom(), container = document.createElement('div');
  let resize;
  container.getBoundingClientRect = () => ({ width });
  document.defaultView.ResizeObserver = class {
    constructor(callback) { resize = callback; }
    observe(target) { assert.equal(target, container); }
  };
  const marks = attachTimelineMarks(container);
  return { marks, container, resize(value) { width = value; resize([{ target: container, contentRect: { width } }]); } };
}
const fromUtc = Date.parse('2026-01-01T00:00:00Z'), toUtc = Date.parse('2026-12-31T23:59:59.999Z');

test('calendar return marks have exact endpoints and no new labels or interactions', () => {
  const h = harness(); h.marks.calendar({ fromUtc, toUtc, timeZone: 'UTC', labels: false });
  const nodes = h.container.children;
  assert.ok(nodes.length > 2 && nodes.length <= 24);
  assert.equal(nodes[0].style['--hour-position'], '0%');
  assert.equal(nodes.at(-1).style['--hour-position'], '100%');
  assert.ok(nodes.every(node => node.children.length === 0 && node.title === ''));
});

test('calendar marks resize without a range change and stop after switching mode', () => {
  const h = harness(900); h.marks.calendar({ fromUtc, toUtc, labels: false });
  const wide = h.container.children;
  h.marks.calendar({ fromUtc, toUtc, labels: false });
  assert.equal(h.container.children, wide, 'scrubbing keeps the currently rendered marks');
  h.resize(210); assert.ok(h.container.children.length < wide.length);
  assert.equal(h.container.children.at(-1).style['--hour-position'], '100%');
  h.marks.clear(); h.resize(900); assert.equal(h.container.children.length, 0);
});

test('only transit calendar mode adds sparse labels, without removing unlabelled ticks', () => {
  const h = harness(320);
  h.marks.calendar({ fromUtc, toUtc, labels: false }); const tickCount = h.container.children.length;
  h.marks.calendar({ fromUtc, toUtc, labels: true });
  assert.equal(h.container.children.length, tickCount);
  const labelled = h.container.children.filter(node => node.children.length);
  assert.deepEqual(labelled.map(mark => mark.children[0].textContent), ['янв', 'март', 'май', 'июль', 'сент', 'нояб']);
  h.marks.calendar({ fromUtc, toUtc, labels: false });
  assert.ok(h.container.children.every(node => node.children.length === 0));
});


const captions = h => h.container.children.flatMap(mark => mark.children.map(label => label.textContent));

test('two years in a narrow chronicle show both January landmarks without duplicating the date fields', () => {
  const h = harness(342);
  h.marks.calendar({ fromUtc: Date.parse('2026-10-10T00:00:00Z'), toUtc: Date.parse('2028-10-10T23:59:59.999Z'), labels: true });
  assert.deepEqual(captions(h), ['2027', '2028']);
  assert.equal(h.container.children[0].children.length, 0);
  assert.equal(h.container.children.at(-1).children.length, 0);
});

test('three months show every readable month boundary rather than a single middle caption', () => {
  const h = harness(342);
  h.marks.calendar({ fromUtc: Date.parse('2026-10-10T00:00:00Z'), toUtc: Date.parse('2027-01-10T23:59:59.999Z'), labels: true });
  assert.deepEqual(captions(h), ['нояб', 'дек', 'янв']);
});

test('an exact edge is captioned only when it belongs to the same calendar step and phase', () => {
  const h = harness(342);
  h.marks.calendar({ fromUtc: Date.parse('1998-01-01T00:00:00Z'), toUtc: Date.parse('2028-01-01T23:59:59.999Z'), labels: true });
  assert.deepEqual(captions(h), ['2000', '2005', '2010', '2015', '2020', '2025']);
  assert.equal(h.container.children[0].children.length, 0, '1998 is not a five-year boundary');
  h.marks.calendar({ fromUtc: Date.parse('2026-01-01T00:00:00Z'), toUtc: Date.parse('2028-10-10T23:59:59.999Z'), labels: true });
  assert.deepEqual(captions(h), ['2026', '2027', '2028']);
});

test('dense labels use one regular calendar stride and remain inside the rail', () => {
  const h = harness(900);
  h.marks.calendar({ fromUtc: Date.parse('1900-01-01T00:00:00Z'), toUtc: Date.parse('2000-01-01T00:00:00Z'), labels: true });
  const labels = captions(h).map(Number);
  assert.ok(labels.length >= 3 && labels.length <= 8);
  const step = labels[1] - labels[0];
  assert.ok(step > 0);
  for (let index = 2; index < labels.length; index++) assert.equal(labels[index] - labels[index - 1], step);
  let right = -Infinity;
  for (const mark of h.container.children.filter(mark => mark.children.length)) {
    const length = mark.children[0].textContent.length * 6;
    const position = Number.parseFloat(mark.style['--hour-position']) / 100 * 900;
    const left = mark.dataset.edge === 'start' ? 0 : mark.dataset.edge === 'end' ? 900 - length : position - length / 2;
    assert.ok(left >= 0 && left + length <= 900);
    assert.ok(left >= right + 14);
    right = left + length;
  }
});

test('a short interval without calendar boundaries retains one truthful time caption', () => {
  const h = harness(342);
  h.marks.calendar({ fromUtc: Date.parse('2026-10-10T12:03:00Z'), toUtc: Date.parse('2026-10-10T12:07:00Z'), labels: true });
  assert.deepEqual(captions(h), ['12:03']);
  assert.equal(h.container.children.length, 2);
  assert.equal(h.container.children[0].style['--hour-position'], '0%');
});

test('a skipped calendar date does not introduce an off-grid caption', () => {
  const h = harness(342);
  h.marks.calendar({ fromUtc: Date.parse('2011-12-29T10:00:00Z'), toUtc: Date.parse('2012-01-04T09:59:59.999Z'), timeZone: 'Pacific/Apia', labels: true });
  assert.deepEqual(captions(h), ['01.01', '03.01']);
  assert.equal(h.container.children.length, 5, 'unlabelled ticks remain on the rail');
});
