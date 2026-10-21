import type { SelectionIdentity } from '../selection/selection-targets.ts';
type KnowledgeType = 'gate' | 'center' | 'channel';
export type Knowledge = ReturnType<typeof attachKnowledge>;

import { escapeHtml as escape } from '../ui/html.ts';
import { GATE_DESCRIPTIONS } from '../reference/gate-descriptions.ts';
import { CENTERS, GATES, CHANNELS, getGate, getCenter, getChannel } from '../reference/catalog.ts';

const catalog = { gate: GATES, center: CENTERS, channel: CHANNELS };
const names = { gate: 'Ворота', center: 'Центры', channel: 'Каналы' };
const jump = (type: KnowledgeType, id: string | number, label: string) => `<button class="knowledge-link" data-jump-type="${type}" data-jump-id="${id}">${escape(label)}<span aria-hidden="true">↗</span></button>`;

export function attachKnowledge(page: HTMLElement, onSelect: (selection: SelectionIdentity) => void) {
  let type: KnowledgeType = 'gate', id: string | number = 37;
  const index = page.querySelector<HTMLElement>('#knowledgeIndex')!;
  const article = page.querySelector<HTMLElement>('#knowledgeArticle')!;
  function render() {
    // Topics share their category's index, including its scroll and focus nodes.
    if (index.dataset.category !== type) {
      page.querySelectorAll<HTMLElement>('[data-knowledge-category]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.knowledgeCategory === type)));
      index.dataset.category = type;
      index.setAttribute('aria-label', names[type]);
      index.innerHTML = catalog[type].map(item => `<button data-topic-id="${item.id}" aria-label="${escape(type === 'gate' ? `Ворота ${item.id}: ${item.name}` : item.name)}" aria-pressed="${String(item.id) === String(id)}">${type === 'gate' ? item.id : type === 'channel' ? `<span>${item.id}</span><small>${escape(item.name)}</small>` : escape(item.name)}</button>`).join('');
    } else {
      const previous = index.querySelector('[aria-pressed="true"]');
      const selected = index.querySelector(`[data-topic-id="${id}"]`);
      if (previous !== selected) {
        previous?.setAttribute('aria-pressed', 'false');
        selected?.setAttribute('aria-pressed', 'true');
      }
    }
    let title, text = '', links = '';
    if (type === 'gate') {
      const gate = getGate(id)!;
      title = `${gate.id} · ${gate.name}`;
      text = `<p>${escape(GATE_DESCRIPTIONS[gate.id])}</p>`;
      links = `<h4>Центр</h4>${jump('center', gate.center, getCenter(gate.center)!.name)}<h4>Связи</h4>${CHANNELS.filter(channel => channel.gates.includes(gate.id)).map(channel => jump('channel', channel.id, `${channel.id} · ${channel.name}`)).join('')}`;
    } else if (type === 'center') {
      const center = getCenter(id)!;
      title = center.name;
      links = `<h4>Ворота центра</h4>${GATES.filter(gate => gate.center === id).map(gate => jump('gate', gate.id, `${gate.id} · ${gate.name}`)).join('')}`;
    } else {
      const channel = getChannel(id)!;
      title = `${channel.id} · ${channel.name}`;
      text = `<p>${channel.gates.map(gate => escape(getCenter(getGate(gate)!.center)!.name)).join(' — ')}.</p>`;
      links = `<h4>Ворота канала</h4>${channel.gates.map(gate => jump('gate', gate, `${gate} · ${getGate(gate)!.name}`)).join('')}`;
    }
    article.innerHTML = `<h3>${escape(title)}</h3>${text}<button class="knowledge-show" data-show-topic>Показать на схеме <span aria-hidden="true">↗</span></button><div class="knowledge-connections">${links}</div>`;
    article.scrollTop = 0;
    if (!page.hidden) index.querySelector('[aria-pressed="true"]')?.scrollIntoView({ block: 'nearest' });
  }
  page.addEventListener('click', event => {
    const button = (event.target as Element).closest('button');
    if (!button) return;
    if (button.hasAttribute('data-show-topic')) { onSelect({type, id}); return; }
    if (button.dataset.knowledgeCategory) { type = button.dataset.knowledgeCategory as KnowledgeType; id = catalog[type][0].id; render(); }
    if (button.dataset.topicId) {
      id = type === 'gate' ? Number(button.dataset.topicId) : button.dataset.topicId;
      render(); index.querySelector<HTMLElement>('[aria-pressed="true"]')?.focus({preventScroll: true});
    }
    if (button.dataset.jumpType) { type = button.dataset.jumpType as KnowledgeType; id = type === 'gate' ? Number(button.dataset.jumpId) : button.dataset.jumpId!; render(); }
  });
  return { show(selection: SelectionIdentity | null | undefined) {
    if (selection && catalog[selection.type as KnowledgeType]?.some(item => String(item.id) === String(selection.id))) { type = selection.type as KnowledgeType; id = selection.id; }
    render(); page.hidden = false; index.querySelector('[aria-pressed="true"]')?.scrollIntoView({ block: 'nearest' });
  }, hide() { page.hidden = true; }};
}
