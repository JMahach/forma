import { renderBodygraph } from '../bodygraph/bodygraph.js';

// Educational illustration, not a calculated natal chart or a live transit.
export const LOVE_GATES = Object.freeze([10, 15, 25, 46]);
export function renderLoveDiagram() {
  return renderBodygraph({ personality: [46], design: [] }, null, {
    interactive: false, showActivations: false, idPrefix: 'love-story',
    selections: LOVE_GATES.map(id => ({ type: 'gate', id })),
  });
}

const themes = {
  10: ['Любовь к себе', 'Тема этих ворот — собственное поведение: как оставаться собой в обычных поступках. Любовь к себе здесь можно понимать не как превосходство над другими, а как уважение к своей природе. Не становиться чьей-то копией, чтобы заслужить принятие.'],
  15: ['Любовь к человечеству', 'Здесь любовь обращена к разнообразию людей и их ритмов. Кто-то живёт размеренно, кто-то — порывами; чужой темп не обязательно неправильный. Образ этих ворот — видеть за различиями человека, не требуя, чтобы все были похожи на нас.'],
  25: ['Всеобщая любовь', 'В системе эти ворота связаны с невинностью — открытостью жизни, а не отсутствием опыта. Это образ любви, которая не ограничена одним человеком или набором условий. Способность встречать происходящее с открытым сердцем не означает отказываться от собственных границ.'],
  46: ['Любовь к телу', 'Эти ворота связывают с телом и непосредственным проживанием опыта. Жизнь происходит не только в мыслях, но и в прикосновении, движении, тепле. Образ этих ворот — ценить тело не лишь за внешность или результат, а как возможность быть здесь и чувствовать жизнь.'],
};

if (typeof document !== 'undefined') {
  const chart = document.querySelector('#love-chart');
  chart.insertAdjacentHTML('beforeend', renderLoveDiagram());
  function focusGate(id) {
    document.querySelectorAll('button[data-gate]').forEach(button => {
      button.setAttribute('aria-pressed', String(Number(button.dataset.gate) === id));
    });
    chart.querySelectorAll('[data-type="gate"]').forEach(gate => {
      gate.dataset.focus = String(Number(gate.dataset.id) === id);
    });
    document.querySelector('#detail-title').textContent = `${id} · ${themes[id][0]}`;
    document.querySelector('#detail-text').textContent = themes[id][1];
  }
  document.querySelectorAll('button[data-gate]').forEach(button => {
    button.addEventListener('click', () => focusGate(Number(button.dataset.gate)));
  });
  focusGate(46);
  const toggle = document.querySelector('#view-toggle');
  toggle.addEventListener('click', () => {
    const full = toggle.getAttribute('aria-pressed') !== 'true';
    toggle.setAttribute('aria-pressed', String(full));
    toggle.textContent = full ? 'К G-центру ↙' : 'Вся схема ↗';
    chart.setAttribute('viewBox', full ? '80 25 480 755' : '236 357 168 158');
  });
}
