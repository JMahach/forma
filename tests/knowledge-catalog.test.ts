import test from 'node:test';
import assert from 'node:assert/strict';
import { KNOWLEDGE_COLLECTIONS, KNOWLEDGE_ENTRIES } from '../src/reference/knowledge-content.ts';
import * as catalog from '../src/reference/knowledge-catalog.ts';

test('selection mapping translates topology names, node names and reversed channels', () => {
  const cases = [
    [{ type: 'gate', id: 8 }, 'gate.8'],
    [{ type: 'center', id: 'heart' }, 'center.ego'],
    [{ type: 'center', id: 'solar' }, 'center.solar-plexus'],
    [{ type: 'channel', id: '8-1' }, 'channel.1-8'],
    [{ type: 'channel', id: '64–47' }, 'channel.47-64'],
    [{ type: 'planet', id: 'north_node' }, 'planet.north-node'],
  ] as const;
  for (const [selection, id] of cases) {
    assert.equal(catalog.knowledgeEntryForSelection(selection)?.id, id);
  }
  assert.deepEqual(catalog.knowledgeSelectionForEntry(catalog.getKnowledgeEntry('center.ego')!), { type: 'center', id: 'heart' });
  assert.deepEqual(catalog.knowledgeSelectionForEntry(catalog.getKnowledgeEntry('center.solar-plexus')!), { type: 'center', id: 'solar' });
  assert.deepEqual(catalog.knowledgeSelectionForEntry(catalog.getKnowledgeEntry('gate.8')!), { type: 'gate', id: 8 });
  assert.deepEqual(catalog.knowledgeSelectionForEntry(catalog.getKnowledgeEntry('channel.47-64')!), { type: 'channel', id: '47-64' });
});

test('unknown selections and non-diagram articles cannot produce a chart target', () => {
  for (const selection of [null, undefined, { type: 'gate', id: 99 }, { type: 'channel', id: '1-2' }, { type: 'integration', id: 'integration' }, { type: 'mandala-cross', id: '1' }] as const) {
    assert.equal(catalog.knowledgeEntryForSelection(selection), undefined);
  }
  assert.equal(catalog.getKnowledgeEntry('missing'), undefined);
  for (const id of ['planet.sun', 'profile.1-3', 'concept.bodygraph', 'type.generator']) {
    assert.equal(catalog.knowledgeSelectionForEntry(catalog.getKnowledgeEntry(id)!), null);
  }
});

test('empty search preserves the selected collection and its editorial ordering', () => {
  assert.deepEqual(catalog.findKnowledgeEntries('  ', 'centers').map(e => e.id), [
    'center.head', 'center.ajna', 'center.throat', 'center.g', 'center.ego',
    'center.spleen', 'center.solar-plexus', 'center.sacral', 'center.root',
  ]);
  assert.deepEqual(catalog.findKnowledgeEntries('', 'missing'), []);
  for (const collection of KNOWLEDGE_COLLECTIONS) {
    for (const id of collection.entryIds) assert.equal(catalog.knowledgeCollectionForEntry(catalog.getKnowledgeEntry(id)!).id, collection.id);
  }
});

test('nonempty search is global and matches public keywords, aliases and normalized spelling', () => {
  assert.ok(catalog.findKnowledgeEntries('красное', 'gates').some(e => e.id === 'concept.personality-design'));
  assert.ok(catalog.findKnowledgeEntries('Горло', 'gates').some(e => e.id === 'center.throat'));
  assert.deepEqual(catalog.findKnowledgeEntries('ЧЁРНОЕ', 'centers').map(e => e.id), catalog.findKnowledgeEntries('черное', 'gates').map(e => e.id));
  for (const query of ['1-8', '1–8', '1—8']) assert.equal(catalog.findKnowledgeEntries(query, 'centers')[0]?.id, 'channel.1-8');
  assert.deepEqual(catalog.findKnowledgeEntries('Jovian Archive', 'gates'), []);
  assert.deepEqual(catalog.findKnowledgeEntries('абракадабра', 'gates'), []);
});

test('exact numeric topics rank ahead of incidental matches and compound queries require every term', () => {
  const results = catalog.findKnowledgeEntries('8', 'basics');
  assert.equal(results[0]?.id, 'gate.8');
  assert.equal(results.some(e => e.id === 'gate.48'), false);
  const and = catalog.findKnowledgeEntries('красное чёрное', 'gates');
  assert.ok(and.some(e => e.id === 'concept.personality-design'));
  assert.deepEqual(catalog.findKnowledgeEntries('красное абракадабра', 'gates'), []);
  assert.equal(catalog.findKnowledgeEntries('Вклад', 'centers')[0]?.id, 'gate.8');
});

test('title helpers format numeric headings while preserving nonnumeric headings', () => {
  assert.equal(catalog.knowledgeEntryTitle(catalog.getKnowledgeEntry('gate.8')!), '8 · Вклад');
  assert.equal(catalog.knowledgeTopicLabel(catalog.getKnowledgeEntry('gate.8')!), 'Вклад');
  const channel = catalog.getKnowledgeEntry('channel.1-8')!;
  assert.match(catalog.knowledgeEntryTitle(channel), /^1[–-]8 · /);
  assert.doesNotMatch(catalog.knowledgeTopicLabel(channel), /^1[–-]8/);
  assert.equal(catalog.knowledgeEntryTitle(catalog.getKnowledgeEntry('concept.bodygraph')!), 'Как устроена карта');
  assert.equal(catalog.knowledgeTopicLabel(catalog.getKnowledgeEntry('concept.bodygraph')!), 'Как устроена карта');
  assert.ok(KNOWLEDGE_ENTRIES.every(e => catalog.knowledgeEntryTitle(e).length && catalog.knowledgeTopicLabel(e).length));
});


test('all copied gate and channel screen titles find their own article first', () => {
  assert.equal(catalog.findKnowledgeEntries('8 · Вклад', 'centers')[0]?.id, 'gate.8');
  assert.equal(catalog.findKnowledgeEntries('1–8 · Вдохновение', 'gates')[0]?.id, 'channel.1-8');
  const numbered = KNOWLEDGE_ENTRIES.filter(entry => entry.kind === 'gate' || entry.kind === 'channel');
  assert.equal(numbered.length, 100);
  for (const entry of numbered) {
    const copied = catalog.knowledgeEntryTitle(entry);
    assert.equal(catalog.findKnowledgeEntries(copied, 'basics')[0]?.id, entry.id, copied);
  }
});

test('screen title search keeps number boundaries, partial words and every combined term', () => {
  for (const query of ['8', 'Вклад', 'Вкл', '8 Вкл', 'Вкл 8', '8 · Вкл', '  8   ·   ВКЛАД  ']) {
    const results = catalog.findKnowledgeEntries(query, 'centers');
    assert.ok(results.some(entry => entry.id === 'gate.8'), query);
    if (query.includes('8')) assert.equal(results.some(entry => entry.id === 'gate.48'), false, query);
  }
  for (const query of ['1-8', '1–8', '1—8', '1–8 Вдох', '1–8 · Вдох', '1–8 · Вдохновение']) {
    assert.equal(catalog.findKnowledgeEntries(query, 'gates')[0]?.id, 'channel.1-8', query);
  }
  for (const query of ['8 · Вклад абракадабра', '1–8 · Вдохновение абракадабра']) {
    assert.deepEqual(catalog.findKnowledgeEntries(query, 'gates'), [], query);
  }
});

test('numeric search prepares its matchers once per query, independent of catalogue size', () => {
  const OriginalRegExp = globalThis.RegExp;
  let preparations = 0;
  globalThis.RegExp = new Proxy(OriginalRegExp, {
    construct(target, args) { preparations++; return Reflect.construct(target, args); },
  });
  try {
    assert.deepEqual(catalog.findKnowledgeEntries('10 20', 'gates').map(entry => entry.id), ['channel.10-20']);
    assert.equal(preparations, 2, 'two numeric terms need two matchers, not a new matcher for each article');
  } finally { globalThis.RegExp = OriginalRegExp; }
});
