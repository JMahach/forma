import { escapeHtml as escape } from '../ui/html.js';
import { CENTERS, GATES, CHANNELS, getGate, getCenter, getChannel } from '../reference/catalog.js';

const catalog = { gate: GATES, center: CENTERS, channel: CHANNELS };
const names = { gate: 'Ворота', center: 'Центры', channel: 'Каналы' };
const jump = (type, id, label) => `<button class="knowledge-link" data-jump-type="${type}" data-jump-id="${id}">${escape(label)}<span aria-hidden="true">↗</span></button>`;

export function attachKnowledge(dialog, onSelect) {
  let type = 'gate', id = 37;
  let pressedOutside = false;
  const index = dialog.querySelector('#knowledgeIndex');
  const article = dialog.querySelector('#knowledgeArticle');
  function outsideDialog(event) {
    if (event.target !== dialog) return false;
    const rect = dialog.getBoundingClientRect();
    return event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom;
  }
  dialog.addEventListener('pointerdown', event => { pressedOutside = event.button === 0 && outsideDialog(event); });
  dialog.addEventListener('pointercancel', () => { pressedOutside = false; });
  dialog.addEventListener('close', () => { pressedOutside = false; });
  function render() {
    dialog.querySelectorAll('[data-knowledge-category]').forEach(button => button.setAttribute('aria-pressed', button.dataset.knowledgeCategory === type));
    index.dataset.category = type;
    index.setAttribute('aria-label', names[type]);
    index.innerHTML = catalog[type].map(item => `<button data-topic-id="${item.id}" aria-label="${escape(type === 'gate' ? `Ворота ${item.id}: ${item.name}` : item.name)}" aria-pressed="${String(item.id) === String(id)}">${type === 'gate' ? item.id : type === 'channel' ? `<span>${item.id}</span><small>${escape(item.name)}</small>` : escape(item.name)}</button>`).join('');
    let title, text = '', links = '';
    if (type === 'gate') {
      const gate = getGate(id);
      title = `${gate.id} · ${gate.name}`;
      text = `<p>${escape(gate.summary)}</p>`;
      links = `<h4>Центр</h4>${jump('center', gate.center, getCenter(gate.center).name)}<h4>Связи</h4>${CHANNELS.filter(channel => channel.gates.includes(gate.id)).map(channel => jump('channel', channel.id, `${channel.id} · ${channel.name}`)).join('')}`;
    } else if (type === 'center') {
      const center = getCenter(id);
      title = center.name;
      links = `<h4>Ворота центра</h4>${GATES.filter(gate => gate.center === id).map(gate => jump('gate', gate.id, `${gate.id} · ${gate.name}`)).join('')}`;
    } else {
      const channel = getChannel(id);
      title = `${channel.id} · ${channel.name}`;
      text = `<p>${channel.gates.map(gate => escape(getCenter(getGate(gate).center).name)).join(' — ')}.</p>`;
      links = `<h4>Ворота канала</h4>${channel.gates.map(gate => jump('gate', gate, `${gate} · ${getGate(gate).name}`)).join('')}`;
    }
    article.innerHTML = `<h3>${escape(title)}</h3>${text}<button class="knowledge-show" data-show-topic>Показать на схеме <span aria-hidden="true">↗</span></button><div class="knowledge-connections">${links}</div>`;
    article.scrollTop = 0;
    if (dialog.open) index.querySelector('[aria-pressed="true"]')?.scrollIntoView({ block: 'nearest' });
  }
  dialog.addEventListener('click', event => {
    const dismiss = pressedOutside && outsideDialog(event);
    pressedOutside = false;
    if (dismiss) {
      event.preventDefault();
      event.stopPropagation();
      dialog.close();
      return;
    }
    const button = event.target.closest('button');
    if (!button) return;
    if (button.hasAttribute('data-close-knowledge')) { dialog.close(); return; }
    if (button.hasAttribute('data-show-topic')) { dialog.close(); onSelect({type, id}); return; }
    if (button.dataset.knowledgeCategory) { type = button.dataset.knowledgeCategory; id = catalog[type][0].id; render(); }
    if (button.dataset.topicId) {
      id = type === 'gate' ? Number(button.dataset.topicId) : button.dataset.topicId;
      render(); index.querySelector('[aria-pressed="true"]')?.focus({preventScroll: true});
    }
    if (button.dataset.jumpType) { type = button.dataset.jumpType; id = type === 'gate' ? Number(button.dataset.jumpId) : button.dataset.jumpId; render(); }
  });
  return { show(selection) {
    if (selection && catalog[selection.type]?.some(item => String(item.id) === String(selection.id))) { type = selection.type; id = selection.id; }
    render(); dialog.showModal(); index.querySelector('[aria-pressed="true"]')?.scrollIntoView({ block: 'nearest' });
  }};
}
