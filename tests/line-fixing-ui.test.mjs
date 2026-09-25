import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { renderActivationColumns } from '../src/activations/activations.js';
import { DRAWING_BOUNDS } from '../src/bodygraph/gestures.js';

const activation = (planet, gate, line) => ({ planet, gate, line });
const chart = (personality, design = []) => ({ activations: { personality, design } });
const rowFor = (markup, id) => {
  const start = markup.lastIndexOf('<g class="activation-row"', markup.indexOf(`data-activation="${id}"`));
  const next = markup.indexOf('<g class="activation-row"', start + 1);
  return markup.slice(start, next === -1 ? undefined : next);
};

test('exaltation, detriment and both polarities get minimal independent marks', () => {
  for (const [entries, expected, label] of [
    [[activation('pluto', 43, 2)], 'exalted', 'Экзальтация'],
    [[activation('moon', 43, 2)], 'detriment', 'Падение'],
    [[activation('pluto', 43, 2), activation('moon', 23, 1)], 'juxtaposed', 'Экзальтация и падение']
  ]) {
    const markup = renderActivationColumns(chart(entries));
    const row = rowFor(markup, `personality-${entries[0].planet}`);
    assert.match(row, new RegExp(`data-fixing="${expected}"`));
    assert.ok(row.includes(label));
    assert.ok(row.includes(label.toLowerCase()));
    assert.match(row, /pointer-events="none" aria-hidden="true"><path/);
    assert.match(row, /transform="translate\(103 0\) scale\(1\.15\)"/);
  }
});

test('same gate can have different fixing states in different lines', () => {
  const markup = renderActivationColumns(chart([activation('sun', 55, 2), activation('moon', 55, 1)], [activation('venus', 39, 1)]));
  assert.match(rowFor(markup, 'personality-sun'), /data-fixing="exalted"/);
  assert.match(rowFor(markup, 'personality-moon'), /data-fixing="detriment"/);
});

test('manual charts and unfixed lines receive no invented symbols', () => {
  assert.equal(renderActivationColumns({ personality: [43], design: [23] }), '');
  for (const entry of [activation('sun', 43, 2), activation('sun', 54, 4)]) {
    assert.doesNotMatch(renderActivationColumns(chart([entry])), /class="line-fixing"/);
  }
});

test('marks inherit red or black without moving planet, number, hit area or popup anchor', () => {
  const markup = renderActivationColumns(chart([activation('pluto', 43, 2)], [activation('pluto', 43, 2)]), new Set([43]));
  assert.match(markup, /data-source="design" fill="#c32d35"/);
  assert.match(markup, /data-source="personality" fill="#202020"/);
  for (const [source, x] of [['design', -32], ['personality', 584]]) {
    const row = rowFor(markup, `${source}-pluto`);
    assert.match(row, new RegExp(`transform="translate\\(${x} 694\\)"`));
    assert.match(row, /<rect x="28" y="-20" width="68" height="40"/);
    assert.match(row, /<text x="34" y="0"/);
    const numberStart = row.indexOf(`data-activation="${source}-pluto"`);
    const numberEnd = row.indexOf('</g>', numberStart);
    assert.ok(row.indexOf('class="line-fixing"') > numberEnd, 'marker is not part of the popover anchor');
    assert.ok(x + 103 + 4 * 1.15 <= DRAWING_BOUNDS.x + DRAWING_BOUNDS.width, 'enlarged marker fits existing camera bounds');
    assert.ok(x + 103 - 4 * 1.15 >= DRAWING_BOUNDS.x);
    assert.match(row, /aria-pressed="true"/);
  }
  assert.equal((markup.match(/class="bg-activation"/g) || []).length, 2, 'no extra interactive targets');
});

test('enlarged double mark stays inside its row without approaching the numeric hit area', () => {
  const markup = renderActivationColumns(chart([activation('pluto', 43, 2), activation('moon', 23, 1)]));
  const row = rowFor(markup, 'personality-pluto');
  assert.match(row, /data-fixing="juxtaposed" transform="translate\(103 0\) scale\(1\.15\)"/);
  assert.match(row, /d="M -4 -1 L 0 -8 L 4 -1 Z M -4 1 L 0 8 L 4 1 Z"/);
  assert.ok(8 * 1.15 < 20, 'double mark fits the existing row height');
  assert.ok(103 - 4 * 1.15 > 28 + 68, 'mark remains outside the numeric hit area');
});

test('selection and hover keep fixing symbols unchanged', () => {
  const data = chart([activation('pluto', 43, 2), activation('moon', 23, 1)]);
  const symbols = value => [...value.matchAll(/<g class="line-fixing"[^]*?<\/g>/g)].map(match => match[0]);
  const initial = symbols(renderActivationColumns(data));
  assert.deepEqual(symbols(renderActivationColumns(data, new Set([43]))), initial);
  assert.deepEqual(symbols(renderActivationColumns(data, new Set([43, 23]), null, { pressedGates: new Set([23]) })), initial);
});

test('both fixing modules are available through the production server', () => {
  const server = readFileSync(new URL('../server/public-files.mjs', import.meta.url), 'utf8');
  assert.match(server, /'src\/activations\/line-fixing\.js'/);
  assert.match(server, /'src\/activations\/line-fixing-data\.js'/);
});
