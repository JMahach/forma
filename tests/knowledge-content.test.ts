import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  KNOWLEDGE_ENTRIES,
  KNOWLEDGE_COLLECTIONS,
  KNOWLEDGE_RELATION_LABELS,
} from '../src/reference/knowledge-content.ts';

const publicJson = JSON.parse(readFileSync(new URL('../src/reference/knowledge-content.ru.json', import.meta.url), 'utf8'));

test('public knowledge contains the complete agreed reference set', () => {
  assert.equal(KNOWLEDGE_ENTRIES.length, 184);
  assert.equal(new Set(KNOWLEDGE_ENTRIES.map(entry => entry.id)).size, 184);
  for (const [kind, expected] of [['gate', 64], ['channel', 36], ['center', 9], ['line', 6]] as const) {
    assert.equal(KNOWLEDGE_ENTRIES.filter(entry => entry.kind === kind).length, expected, kind);
  }
  assert.deepEqual(
    KNOWLEDGE_ENTRIES.filter(entry => entry.kind === 'gate').map(entry => Number(entry.key)).sort((a, b) => a - b),
    Array.from({ length: 64 }, (_, index) => index + 1),
  );
  const channels = ['1-8','2-14','3-60','4-63','5-15','6-59','7-31','9-52','10-20','10-34','10-57',
    '11-56','12-22','13-33','16-48','17-62','18-58','19-49','20-34','20-57','21-45','23-43',
    '24-61','25-51','26-44','27-50','28-38','29-46','30-41','32-54','34-57','35-36',
    '37-40','39-55','42-53','47-64'];
  assert.deepEqual(KNOWLEDGE_ENTRIES.filter(entry => entry.kind === 'channel').map(entry => entry.id).sort(),
    channels.map(key => `channel.${key}`).sort());
});

test('every public relation and collection member resolves to a published entry', () => {
  const ids = new Set(KNOWLEDGE_ENTRIES.map(entry => entry.id));
  for (const entry of KNOWLEDGE_ENTRIES) {
    assert.ok(entry.title.trim() && entry.short.trim(), entry.id);
    assert.ok(entry.paragraphs.every(paragraph => paragraph.trim()), entry.id);
    for (const relation of entry.relations) {
      assert.ok(ids.has(relation.target), `${entry.id}: ${relation.target}`);
      assert.ok(KNOWLEDGE_RELATION_LABELS[relation.type], `${entry.id}: ${relation.type}`);
    }
  }
  assert.deepEqual(KNOWLEDGE_COLLECTIONS.map(collection => collection.id).sort(),
    ['basics','types','authorities','centers','definitions','channels','circuits','gates','lines','profiles','planets','mandala'].sort());
  const basics = KNOWLEDGE_COLLECTIONS.find(collection => collection.id === 'basics');
  assert.equal(basics?.title, 'Устройство карты');
  for (const id of ['concept.bodygraph','concept.personality-design','concept.activation','concept.center-states','concept.gate-states']) {
    assert.ok(basics?.entryIds.includes(id), id);
  }
  for (const collection of KNOWLEDGE_COLLECTIONS) {
    assert.equal(new Set(collection.entryIds).size, collection.entryIds.length, collection.id);
    for (const id of collection.entryIds) assert.ok(ids.has(id), `${collection.id}: ${id}`);
  }
  assert.ok(ids.has('mandala.overview'));
  assert.equal(KNOWLEDGE_ENTRIES.filter(entry => entry.kind === 'quarter').length, 4);
});

test('public content excludes attribution, internal records and deferred topics', () => {
  const forbiddenKeys = new Set(['sources','sourceRefs','sourceRegistry','depth','curriculumMap',
    'sourceId','locator','path','verification','author','editorialStatus']);
  const inspect = (value: unknown): void => {
    if (Array.isArray(value)) { value.forEach(inspect); return; }
    if (value && typeof value === 'object') {
      for (const [key, nested] of Object.entries(value)) {
        assert.ok(!forbiddenKeys.has(key), `Private field: ${key}`);
        inspect(nested);
      }
    }
  };
  inspect(publicJson);
  const serialized = JSON.stringify(publicJson);
  assert.doesNotMatch(serialized, /(?<![\p{L}\p{N}])(?:Ра|Ra|Уру|Uru)(?![\p{L}\p{N}])/u);
  assert.doesNotMatch(serialized, /concept\.(?:reading-order|about-system)|С чего начать|О карте|[A-Z]:\\\\/u);
  assert.ok(KNOWLEDGE_ENTRIES.every(entry => !entry.id.startsWith('cross.')));
  assert.ok(KNOWLEDGE_ENTRIES.every(entry => !/^gate\.\d+\.\d/.test(entry.id)));
});

test('synchronous TypeScript exports and deliverable JSON contain identical public data', () => {
  assert.deepEqual(publicJson, {
    entries: KNOWLEDGE_ENTRIES,
    collections: KNOWLEDGE_COLLECTIONS,
    relationLabels: KNOWLEDGE_RELATION_LABELS,
  });
});
