import type { SelectionIdentity } from '../selection/selection-targets.ts';
import type { SavedView } from '../data/view-store.ts';
import { attachWorkspaceHeader } from './workspace-header.ts';
import { renderKnowledgeCenterFigure } from './knowledge-center-figure.ts';
import { escapeHtml as escape } from '../ui/html.ts';
import { PHONE_LAYOUT_QUERY } from '../ui/layout/studio-controller.ts';
import { KNOWLEDGE_COLLECTIONS, KNOWLEDGE_RELATION_LABELS } from '../reference/knowledge-content.ts';
import type { KnowledgeEntry } from '../reference/knowledge-content.ts';
import { getKnowledgeEntry, knowledgeEntryForSelection, knowledgeSelectionForEntry,
  knowledgeCollectionForEntry, findKnowledgeEntries, knowledgeEntryTitle, knowledgeTopicLabel } from '../reference/knowledge-catalog.ts';

export type Knowledge = ReturnType<typeof attachKnowledge>;

const categoryIds: Record<string, string> = { gate: 'gates', center: 'centers', channel: 'channels' };
const categoryKeys: Record<string, string> = { gates: 'gate', centers: 'center', channels: 'channel' };
const sectionNames: Record<string, string> = {
  basics: 'Устройство карты', types: 'Типы и стратегии', authorities: 'Авторитеты', centers: 'Центры',
  definitions: 'Определённость', channels: 'Каналы', circuits: 'Контуры', gates: 'Ворота',
  lines: 'Линии', profiles: 'Профили', planets: 'Планеты и узлы', mandala: 'Мандала',
};

function relatedEntries(current: KnowledgeEntry) {
  const groups = new Map<string, KnowledgeEntry[]>();
  const add = (label: string, entry: KnowledgeEntry | undefined) => {
    if (!entry || entry.id === current.id) return;
    if (!groups.has(label)) groups.set(label, []);
    if (!groups.get(label)!.some(item => item.id === entry.id)) groups.get(label)!.push(entry);
  };
  if (current.kind === 'center') {
    const channels = current.relations.filter(relation => relation.type === 'connected_by')
      .flatMap(relation => getKnowledgeEntry(relation.target) ?? []);
    for (const channel of channels) add('Каналы', channel);
    for (const relation of current.relations) {
      const target = getKnowledgeEntry(relation.target);
      if (target?.kind === 'gate') add('Ворота', target);
    }
    for (const channel of channels) for (const relation of channel.relations) {
      const target = getKnowledgeEntry(relation.target);
      if (target?.kind === 'center') add('Центры', target);
    }
    for (const relation of current.relations) {
      const target = getKnowledgeEntry(relation.target);
      if (target && !['gate', 'channel', 'center'].includes(target.kind)) add('По теме', target);
    }
  } else for (const relation of current.relations) {
    add(KNOWLEDGE_RELATION_LABELS[relation.type] ?? 'По теме', getKnowledgeEntry(relation.target));
  }
  return [...groups];
}

function renderConnections(current: KnowledgeEntry) {
  const groups = relatedEntries(current);
  if (!groups.length) return '';
  const groupId = (index: number) => `knowledge-relations-${current.id.replaceAll('.', '-')}-${index}`;
  return `<section class="knowledge-connections" aria-label="Связи"><h4>Связи</h4>
    <div class="knowledge-relation-groups" role="group" aria-label="Виды связей">${groups.map(([label, entries], index) =>
      `<button type="button" data-relation-group="${index}" aria-pressed="${index === 0}" aria-controls="${groupId(index)}">${escape(label)} <span>${entries.length}</span></button>`).join('')}</div>
    ${groups.map(([label, entries], index) => `<div class="knowledge-relation-items" id="${groupId(index)}" data-relation-panel="${index}" aria-label="${escape(label)}" ${index ? 'hidden' : ''}>${entries.map(entry => {
      const numbered = ['gate', 'channel', 'line', 'profile'].includes(entry.kind);
      const gates = entry.kind === 'gate' ? [entry.key] : entry.kind === 'channel' ? String(entry.key).split('-') : [];
      const centers = current.kind === 'center' && entry.kind === 'channel' ? entry.relations
        .flatMap(relation => getKnowledgeEntry(relation.target) ?? [])
        .filter(target => target.kind === 'center' && target.id !== current.id) : [];
      const destination = centers.length ? `<small>↔ ${escape(centers.map(target => knowledgeTopicLabel(target)).join(', '))}</small>` : '';
      return `<button type="button" class="knowledge-link" data-entry-id="${entry.id}" data-related-gates="${gates.join(',')}" aria-label="${escape(knowledgeEntryTitle(entry))}">${numbered ? `<span class="knowledge-link-number">${escape(String(entry.key).replaceAll('-', '–'))}</span>` : ''}<span class="knowledge-link-label">${escape(numbered ? knowledgeTopicLabel(entry) : knowledgeEntryTitle(entry))}${destination}</span><span class="knowledge-link-arrow" aria-hidden="true">↗</span></button>`;
    }).join('')}</div>`).join('')}</section>`;
}

function renderGateDetails(center: KnowledgeEntry, gate: KnowledgeEntry, openRoutes?: ReadonlySet<string>) {
  const channels = gate.relations.flatMap(relation => getKnowledgeEntry(relation.target) ?? [])
    .filter(entry => entry.kind === 'channel' && entry.relations.some(relation => relation.target === center.id));
  return `<h4>${escape(knowledgeEntryTitle(gate))}</h4><p class="knowledge-gate-description">${escape(gate.short)}</p>
    <button type="button" class="knowledge-gate-open" data-entry-id="${gate.id}">Читать о воротах ${escape(String(gate.key))} <span aria-hidden="true">↗</span></button>
    <div class="knowledge-gate-routes" aria-label="Каналы выбранных ворот">${channels.map(channel => {
      const ends = channel.relations.flatMap(relation => getKnowledgeEntry(relation.target) ?? []);
      const opposite = ends.find(entry => entry.kind === 'gate' && entry.id !== gate.id);
      const neighbor = ends.find(entry => entry.kind === 'center' && entry.id !== center.id);
      return `<details class="knowledge-gate-route" data-channel-id="${channel.id}"${(openRoutes ? openRoutes.has(channel.id) : channels.length === 1) ? ' open=""' : ''}>
        <summary><span class="knowledge-route-number">${escape(String(channel.key).replaceAll('-', '–'))}</span><span>${escape(knowledgeTopicLabel(channel))}</span></summary>
        <p>${escape(channel.short)}</p>
        <div class="knowledge-route-destinations">${opposite ? `<button type="button" data-entry-id="${opposite.id}">${escape(knowledgeEntryTitle(opposite))}</button>` : ''}${neighbor ? `<button type="button" data-entry-id="${neighbor.id}">${escape(knowledgeTopicLabel(neighbor))}</button>` : ''}</div>
        <button type="button" class="knowledge-channel-open" data-entry-id="${channel.id}">Читать о канале <span aria-hidden="true">↗</span></button>
      </details>`;
    }).join('')}</div>`;
}

// The library owns reading state only. Selecting a diagram object remains an
// explicit action delegated to the existing workspace navigation.
export function attachKnowledge(page: HTMLElement, onSelect: (selection: SelectionIdentity) => void,
  { isPhone = () => page.ownerDocument?.defaultView?.matchMedia(PHONE_LAYOUT_QUERY).matches ?? false, initialView, initialSelection = null, onChange = () => {}
  }: { isPhone?: () => boolean; initialView?: SavedView['knowledge']; initialSelection?: SelectionIdentity | null; onChange?: () => void } = {}) {
  const header = attachWorkspaceHeader(page, { initialExpanded: initialView?.searchOpen, onChange });
  const index = page.querySelector<HTMLElement>('#knowledgeIndex')!;
  const article = page.querySelector<HTMLElement>('#knowledgeArticle')!;
  const categories = page.querySelector<HTMLElement>('#knowledgeCategories');
  const search = page.querySelector<HTMLInputElement>('#knowledgeSearch');
  const section = page.querySelector<HTMLSelectElement>('#knowledgeSection');
  const count = page.querySelector<HTMLElement>('#knowledgeCount');
  const back = page.querySelector<HTMLButtonElement>('#knowledgeBack');
  const readingLabel = page.querySelector<HTMLElement>('#knowledgeReadingLabel');
  const restoredEntry = initialView && getKnowledgeEntry(initialView.entryId);
  let current = restoredEntry || getKnowledgeEntry('gate.37')!;
  let collection = KNOWLEDGE_COLLECTIONS.find(item => item.id === initialView?.collection)?.id ?? knowledgeCollectionForEntry(current).id;
  if (search && initialView) search.value = initialView.query;
  let query = search?.value.trim() ?? '', indexKey = '', renderedId = '';
  // The first diagram projection must not replace an explicitly remembered article.
  let lastSelection = restoredEntry && initialSelection ? `${initialSelection.type}:${initialSelection.id}` : '';
  let renderedParent = '';
  const readingTrail: string[] = [];
  const centerGates = new Map<string, string>();
  const gateRoutes = new Map<string, Set<string>>();
  const readingPositions = new Map<string, number>();
  let catalogueScroll = 0, catalogueFocus = '';
  page.dataset.view = restoredEntry && initialView?.view === 'article' ? 'article' : 'catalog';
  // Capture visible desktop reading before a responsive layout can hide it.
  article.addEventListener?.('scroll', () => {
    if (!page.hidden && renderedId && (page.dataset.view === 'article' || !isPhone())) {
      readingPositions.set(renderedId, article.scrollTop);
    }
  }, { passive: true });

  function setView(view: 'catalog' | 'article', focus = false) {
    if (page.dataset.view === 'article') readingPositions.set(current.id, article.scrollTop);
    else catalogueScroll = index.scrollTop;
    page.dataset.view = view;
    if (view === 'article') {
      article.scrollTop = readingPositions.get(current.id) ?? 0;
      if (focus && isPhone()) article.querySelector<HTMLElement>('h3')?.focus({ preventScroll: true });
    } else {
      index.scrollTop = catalogueScroll;
      if (focus) {
        const target = index.querySelector<HTMLElement>(`[data-entry-id="${catalogueFocus || current.id}"]`)
          ?? index.querySelector<HTMLElement>('button');
        target?.focus({ preventScroll: Boolean(catalogueFocus) });
      }
    }
    onChange();
  }

  if (categories) categories.innerHTML = KNOWLEDGE_COLLECTIONS.map(item =>
    `<button type="button" data-knowledge-category="${categoryKeys[item.id] ?? item.id}" aria-pressed="false">${escape(sectionNames[item.id] ?? item.title)}<span>${item.entryIds.length}</span></button>`).join('');
  if (section) section.innerHTML = KNOWLEDGE_COLLECTIONS.map(item =>
    `<option value="${item.id}">${escape(sectionNames[item.id] ?? item.title)} · ${item.entryIds.length}</option>`).join('');

  function renderIndex() {
    const key = query ? `search:${query}` : collection;
    const category = categoryKeys[collection] ?? collection;
    page.querySelectorAll<HTMLElement>('[data-knowledge-category]').forEach(button => {
      button.setAttribute('aria-pressed', String((categoryIds[button.dataset.knowledgeCategory!] ?? button.dataset.knowledgeCategory) === collection));
    });
    if (section) section.value = collection;
    if (indexKey !== key) {
      const entries = findKnowledgeEntries(query, collection);
      indexKey = key;
      index.dataset.category = query ? 'search' : category;
      index.setAttribute('aria-label', query ? 'Результаты поиска' : sectionNames[collection]);
      index.innerHTML = entries.length ? entries.map(entry => {
        const numbered = ['gate', 'channel', 'line', 'profile'].includes(entry.kind);
        const label = query ? knowledgeEntryTitle(entry) : knowledgeTopicLabel(entry);
        return `<button type="button" data-entry-id="${entry.id}" data-topic-id="${escape(String(entry.key))}" aria-label="${escape(knowledgeEntryTitle(entry))}" aria-pressed="${entry.id === current.id}">${!query && numbered ? `<span class="knowledge-number">${escape(String(entry.key).replaceAll('-', '–'))}</span>` : ''}<span class="knowledge-topic-name">${escape(label)}</span>${query ? `<small>${escape(sectionNames[knowledgeCollectionForEntry(entry).id])}</small>` : ''}</button>`;
      }).join('') : '<p class="knowledge-empty">Ничего не найдено.<br/>Попробуйте название, номер ворот или другую тему.</p>';
      index.scrollTop = 0;
      if (count) {
        count.hidden = !query;
        count.textContent = query ? `Найдено: ${entries.length}` : '';
      }
    } else {
      const previous = index.querySelector('[aria-pressed="true"]');
      const selected = index.querySelector(`[data-entry-id="${current.id}"]`);
      if (previous !== selected) { previous?.setAttribute('aria-pressed', 'false'); selected?.setAttribute('aria-pressed', 'true'); }
    }
  }

  function rememberGateRoutes() {
    const gate = centerGates.get(renderedId);
    if (!gate) return;
    gateRoutes.set(`${renderedId}/${gate}`, new Set(Array.from(
      article.querySelectorAll<HTMLElement>('.knowledge-gate-route[open]'), route => route.dataset.channelId!)));
  }

  function renderArticle() {
    const parentId = readingTrail.at(-1) ?? '';
    if (renderedId === current.id && renderedParent === parentId) return;
    rememberGateRoutes();
    if (renderedId && (page.dataset.view === 'article' || !isPhone())) readingPositions.set(renderedId, article.scrollTop);
    const parent = getKnowledgeEntry(parentId);
    const intro = `<header class="knowledge-intro">${parent ? `<button type="button" class="knowledge-reading-back" data-reading-back=""><span aria-hidden="true">←</span> ${escape(knowledgeEntryTitle(parent))}</button>` : ''}<p class="knowledge-kicker">${escape(sectionNames[knowledgeCollectionForEntry(current).id])}</p><h3 tabindex="-1">${escape(knowledgeEntryTitle(current))}</h3><p class="knowledge-short">${escape(current.short)}</p></header>`;
    const prose = `<div class="knowledge-prose">${current.paragraphs.map(paragraph => `<p>${escape(paragraph)}</p>`).join('')}</div>`;
    const show = knowledgeSelectionForEntry(current) ? '<button type="button" class="knowledge-show" data-show-topic="">Показать на схеме <span aria-hidden="true">↗</span></button>' : '';
    if (current.kind === 'center') {
      const chosen = getKnowledgeEntry(centerGates.get(current.id) ?? '');
      article.innerHTML = `<div class="knowledge-reading knowledge-center-reading">${intro}<div class="knowledge-main"><aside class="knowledge-center-context" aria-label="Ворота центра и их связи">${renderKnowledgeCenterFigure(current, chosen ? Number(chosen.key) : null)}<section class="knowledge-gate-details" data-gate-details="" aria-live="polite"${chosen ? '' : ' hidden=""'}>${chosen ? renderGateDetails(current, chosen, gateRoutes.get(`${current.id}/${chosen.id}`)) : ''}</section></aside>${prose}${show}</div></div>`;
    } else {
      article.innerHTML = `<div class="knowledge-reading"><div class="knowledge-copy">${intro}<div class="knowledge-main">${prose}${show}</div></div><aside class="knowledge-aside" aria-label="Связи">${renderConnections(current)}</aside></div>`;
    }
    article.dataset.kind = current.kind;
    renderedId = current.id;
    renderedParent = parentId;
    if (readingLabel) readingLabel.textContent = sectionNames[knowledgeCollectionForEntry(current).id];
    article.scrollTop = readingPositions.get(current.id) ?? 0;
  }

  function open(entry: KnowledgeEntry) {
    current = entry;
    renderIndex(); renderArticle();
    onChange();
  }
  function selectCenterGate(id: string) {
    const entry = getKnowledgeEntry(id);
    if (current.kind !== 'center' || entry?.kind !== 'gate' || !current.relations.some(relation => relation.target === id && relation.type === 'contains')) return;
    rememberGateRoutes();
    centerGates.set(current.id, id);
    article.querySelectorAll<SVGElement>('[data-gate-id]').forEach(element => {
      const selected = element.dataset.gateId === String(entry.key);
      element.setAttribute('data-selected', String(selected));
      if (element.classList.contains('knowledge-center-gate')) element.setAttribute('aria-pressed', String(selected));
    });
    const details = article.querySelector<HTMLElement>('[data-gate-details]');
    if (details) { details.innerHTML = renderGateDetails(current, entry, gateRoutes.get(`${current.id}/${entry.id}`)); details.hidden = false; }
  }
  function changeSection(id: string) {
    const next = KNOWLEDGE_COLLECTIONS.find(item => item.id === (categoryIds[id] ?? id));
    if (!next) return;
    setView('catalog');
    readingTrail.length = 0;
    collection = next.id; query = ''; if (search) search.value = '';
    catalogueScroll = 0; catalogueFocus = '';
    open(getKnowledgeEntry(next.entryIds[0])!);
  }
  page.addEventListener('input', event => {
    if (event.target !== search || !search) return;
    query = search.value.trim();
    setView('catalog');
    renderIndex();
  });
  page.addEventListener('change', event => {
    if (event.target === section && section) changeSection(section.value);
  });
  page.addEventListener('click', event => {
    const target = event.target as Element;
    const illustratedGate = target.closest<SVGElement>('[data-gate-id]');
    if (illustratedGate) { selectCenterGate(`gate.${illustratedGate.dataset.gateId}`); return; }
    const button = target.closest<HTMLButtonElement>('button') ?? target.closest<SVGElement>('[data-entry-id]');
    if (!button) return;
    if (button.hasAttribute('data-reading-back')) {
      const previous = getKnowledgeEntry(readingTrail.pop() ?? '');
      if (previous) { open(previous); setView('article', true); article.querySelector<HTMLElement>('h3')?.focus({ preventScroll: true }); }
      return;
    }
    if (button.hasAttribute('data-relation-group')) {
      const group = button.dataset.relationGroup;
      article.querySelectorAll<HTMLElement>('[data-relation-group]').forEach(item => item.setAttribute('aria-pressed', String(item === button)));
      article.querySelectorAll<HTMLElement>('[data-relation-panel]').forEach(panel => { panel.hidden = panel.dataset.relationPanel !== group; });
      return;
    }
    if (button === back) { setView('catalog', true); return; }
    if (button.hasAttribute('data-show-topic')) {
      const selection = knowledgeSelectionForEntry(current);
      if (selection) { lastSelection = `${selection.type}:${selection.id}`; onSelect(selection); }
      return;
    }
    if (button.dataset.knowledgeCategory) { changeSection(button.dataset.knowledgeCategory); return; }
    const entry = button.dataset.entryId ? getKnowledgeEntry(button.dataset.entryId)
      : button.dataset.topicId ? findKnowledgeEntries('', collection).find(item => String(item.key) === button.dataset.topicId) : undefined;
    if (!entry) return;
    // The catalogue stays intact while reading, including when following links.
    const fromIndex = index.contains?.(button) ?? Boolean(button.dataset.topicId);
    if (fromIndex) { catalogueFocus = entry.id; readingTrail.length = 0; }
    else if (entry.id !== current.id) readingTrail.push(current.id);
    open(entry);
    setView('article', true);
    if (fromIndex && !isPhone()) index.querySelector<HTMLElement>(`[data-entry-id="${entry.id}"]`)?.focus({ preventScroll: true });
    else article.querySelector<HTMLElement>('h3')?.focus({ preventScroll: true });
  });
  page.addEventListener('keydown', event => {
    const gate = (event.target as Element).closest<SVGElement>('.knowledge-center-gate');
    if (!gate || !['Enter', ' '].includes(event.key)) return;
    event.preventDefault();
    if (gate.dataset.entryId) selectCenterGate(gate.dataset.entryId);
  });
  const highlight = (event: Event, active: boolean) => {
    const link = (event.target as Element).closest<HTMLElement>('[data-related-gates]');
    if (!link) return;
    const gates = active ? (link.dataset.relatedGates ?? '').split(',') : [];
    article.querySelectorAll<SVGElement>('.knowledge-center-gate').forEach(gate => {
      gate.setAttribute('data-highlighted', String(gates.includes(gate.dataset.entryId?.slice(5) ?? '')));
    });
  };
  for (const name of ['pointerover', 'focusin']) article.addEventListener?.(name, event => highlight(event, true));
  for (const name of ['pointerout', 'focusout']) article.addEventListener?.(name, event => highlight(event, false));
  return {
    get snapshot(): NonNullable<SavedView['knowledge']> {
      return { query: search?.value ?? query, searchOpen: header?.expanded ?? false, collection, entryId: current.id,
        view: page.dataset.view === 'article' ? 'article' : 'catalog' };
    },
    show(selection?: SelectionIdentity | null) {
      page.hidden = false;
      const key = selection ? `${selection.type}:${selection.id}` : '';
      const entry = key && key !== lastSelection ? knowledgeEntryForSelection(selection) : undefined;
      lastSelection = key;
      if (entry) {
        catalogueFocus = '';
        readingTrail.length = 0;
        collection = knowledgeCollectionForEntry(entry).id;
        open(entry); setView('article');
      } else { renderIndex(); renderArticle(); }
      if (page.dataset.view === 'article' || !isPhone()) article.scrollTop = readingPositions.get(current.id) ?? article.scrollTop;
      if (page.dataset.view === 'catalog') index.scrollTop = catalogueScroll;
    },
    hide() {
      if (page.dataset.view === 'article' || !isPhone()) readingPositions.set(current.id, article.scrollTop);
      if (page.dataset.view === 'catalog') catalogueScroll = index.scrollTop;
      page.hidden = true;
    },
  };
}
