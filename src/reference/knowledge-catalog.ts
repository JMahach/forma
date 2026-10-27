import type { SelectionIdentity } from '../selection/selection-targets.ts';
import { KNOWLEDGE_ENTRIES, KNOWLEDGE_COLLECTIONS } from './knowledge-content.ts';
import type { KnowledgeEntry, KnowledgeCollection } from './knowledge-content.ts';

const entries = new Map(KNOWLEDGE_ENTRIES.map(entry => [entry.id, entry]));
const collections = new Map(KNOWLEDGE_COLLECTIONS.map(collection => [collection.id, collection]));
const entryCollections = new Map(KNOWLEDGE_COLLECTIONS.flatMap(collection => collection.entryIds.map(id => [id, collection] as const)));
const centerToContent: Readonly<Record<string, string>> = { heart: 'ego', solar: 'solar-plexus' };
const centerToChart: Readonly<Record<string, string>> = { ego: 'heart', 'solar-plexus': 'solar' };
const normalize = (value: string) => value.toLowerCase().replace(/ё/g, 'е').replace(/[–—]/g, '-').trim().replace(/\s+/g, ' ');

export function getKnowledgeEntry(id: string): KnowledgeEntry | undefined { return entries.get(id); }

export function knowledgeEntryForSelection(selection: SelectionIdentity | null | undefined): KnowledgeEntry | undefined {
  if (!selection) return undefined;
  let key = String(selection.id);
  switch (selection.type) {
    case 'gate': key = String(Number(key)); break;
    case 'center': key = centerToContent[key] ?? key; break;
    case 'planet': key = key.replace(/_/g, '-'); break;
    case 'channel': {
      const match = normalize(key).match(/^(\d+)\s*-\s*(\d+)$/);
      if (!match) return undefined;
      key = [Number(match[1]), Number(match[2])].sort((a, b) => a - b).join('-');
      break;
    }
    default: return undefined;
  }
  return getKnowledgeEntry(`${selection.type}.${key}`);
}

export function knowledgeSelectionForEntry(entry: KnowledgeEntry): SelectionIdentity | null {
  if (!entries.has(entry.id)) return null;
  switch (entry.kind) {
    case 'gate': return { type: 'gate', id: Number(entry.key) };
    case 'center': return { type: 'center', id: centerToChart[String(entry.key)] ?? String(entry.key) };
    case 'channel': return { type: 'channel', id: String(entry.key) };
    default: return null;
  }
}

export function knowledgeCollectionForEntry(entry: KnowledgeEntry): KnowledgeCollection {
  const collection = entryCollections.get(entry.id);
  if (!collection) throw new Error(`Unknown knowledge entry: ${entry.id}`);
  return collection;
}

// Only numeric gate/channel headings are reformatted; profile names keep their notation.
function numericHeading(entry: KnowledgeEntry): RegExpMatchArray | null {
  return entry.kind === 'gate' || entry.kind === 'channel'
    ? entry.title.match(/^(\d+(?:\s*[-–—]\s*\d+)?)\s+[—–-]\s+(.+)$/) : null;
}
export function knowledgeEntryTitle(entry: KnowledgeEntry): string {
  const heading = numericHeading(entry);
  return heading ? `${heading[1]} · ${heading[2]}` : entry.title;
}
export function knowledgeTopicLabel(entry: KnowledgeEntry): string { return numericHeading(entry)?.[2] ?? entry.title; }

const searchIndex = KNOWLEDGE_ENTRIES.map((entry, order) => ({
  entry, order,
  text: normalize([entry.id, entry.title, knowledgeEntryTitle(entry), ...entry.aliases, ...entry.keywords, entry.short].join(' ')),
  exact: [entry.title, knowledgeEntryTitle(entry), knowledgeTopicLabel(entry), ...entry.aliases].map(normalize),
}));

export function findKnowledgeEntries(query: string, collectionId: string): readonly KnowledgeEntry[] {
  const normalized = normalize(query);
  if (!normalized) return (collections.get(collectionId)?.entryIds ?? []).flatMap(id => {
    const entry = entries.get(id);
    return entry ? [entry] : [];
  });
  const terms = normalized.split(' ');
  return searchIndex.filter(({ text }) => terms.every(term => /^\d+$/.test(term)
    ? new RegExp(`(^|\\D)${term}(?!\\d)`).test(text)
    : text.includes(term)))
    .map(item => ({ ...item, rank: item.entry.kind === 'gate' && String(item.entry.key) === normalized ? 0
      : item.exact.includes(normalized) || normalize(String(item.entry.key)) === normalized ? 1 : 2 }))
    .sort((a, b) => a.rank - b.rank || a.order - b.order)
    .map(item => item.entry);
}
