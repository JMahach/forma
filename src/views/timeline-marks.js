import { lifeDecadeMarks } from '../domain/personal-age.js';

// One owner replaces a rail's decorations and caches its current mode. Changing
// between hours and years never needs a separate clearing pass from another view.
export function attachTimelineMarks(container) {
  let previousMode, previousKey;
  function render(mode, key, createMarks) {
    if (!container || mode === previousMode && key === previousKey) return;
    previousMode = mode; previousKey = key;
    container.replaceChildren(...createMarks());
  }
  function clear() { render('empty', null, () => []); }
  return {
    clear,
    day(day, samples, timeAt) {
      if (!day || !(samples > 1)) { clear(); return; }
      render('day', day, () => {
        const marks = [];
        function add(hour, position) {
          const mark = container.ownerDocument.createElement('span');
          const label = container.ownerDocument.createElement('span');
          const major = hour % 6 === 0;
          mark.className = `day-hour-mark${major ? ' is-major' : ''}`;
          mark.style.setProperty('--hour-position', `${position}%`);
          label.textContent = major ? String(hour).padStart(2, '0') : '';
          mark.append(label); marks.push(mark);
        }
        // The day owner supplies actual local minutes, including repeated or
        // missing hours. Scrubbing the same day reuses all existing marks.
        for (let index = 0; index < samples; index++) {
          const time = timeAt(day, index);
          if (time.slice(3, 5) === '00') add(Number(time.slice(0, 2)), index / (samples - 1) * 100);
        }
        // 24 labels the boundary; the selectable range ends at the last minute.
        add(24, 100);
        return marks;
      });
    },
    life(natal, fromUtc, toUtc) {
      if (!natal) { clear(); return; }
      const key = JSON.stringify([natal.utc, natal.timezone, fromUtc, toUtc]);
      render('life', key, () => lifeDecadeMarks(natal, fromUtc, toUtc).map(({ age, utc }) => {
        const mark = container.ownerDocument.createElement('span');
        mark.className = `life-year-mark${age % 20 === 0 ? ' is-major' : ''}`;
        mark.dataset.age = String(age);
        mark.style.setProperty('--hour-position', `${(utc - fromUtc) / (toUtc - fromUtc) * 100}%`);
        return mark;
      }));
    },
  };
}
