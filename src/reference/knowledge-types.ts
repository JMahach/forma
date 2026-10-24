export interface KnowledgeRelation {
  readonly type: string;
  readonly target: string;
}

export interface KnowledgeEntry {
  readonly id: string;
  readonly kind: string;
  readonly key: string | number;
  readonly title: string;
  readonly aliases: readonly string[];
  readonly short: string;
  readonly paragraphs: readonly string[];
  readonly keywords: readonly string[];
  readonly relations: readonly KnowledgeRelation[];
  readonly mechanics?: Readonly<Record<string, unknown>>;
}

export interface KnowledgeCollection {
  readonly id: string;
  readonly title: string;
  readonly entryIds: readonly string[];
}
