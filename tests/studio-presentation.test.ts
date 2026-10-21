import test from 'node:test';
import assert from 'node:assert/strict';
import { studioPresentation } from '../src/ui/studio-presentation.ts';

const personal = { personalAvailable: true, lifetime: { opened: true, mode: 'lifetime' as const }, returnsOpened: true };
test('Returns need a personal Lifetime owner; an open drawer alone cannot show them', () => {
  assert.equal(studioPresentation(personal).returnsVisible, true);
  for (const change of [{ personalAvailable: false }, { dayOpened: true }, { lifetime: null },
    { lifetime: { opened: false, mode: 'lifetime' as const } }, { lifetime: { opened: true, mode: 'day' as const } }] as const) {
    const view = studioPresentation({ ...personal, ...change });
    assert.equal(view.personalTimelineVisible, false);
    assert.equal(view.returnsVisible, false);
  }
  const closed = studioPresentation({ ...personal, returnsOpened: false });
  assert.equal(closed.personalTimelineVisible, true);
  assert.equal(closed.returnsVisible, false);
});
test('pending opening highlights the tool without exposing a not-yet-open panel', () => {
  const view = studioPresentation({ personalAvailable: true, returnsEnabled: true, returnsOpened: true });
  assert.equal(view.toggleEnabled, true);
  assert.equal(view.returnsVisible, false);
  assert.equal(view.lifetimeAvailable, true);
  assert.equal(view.lifetimeHeadingVisible, false);
  assert.equal(view.toggleLabel, 'Возвраты');
});
test('timeline modes are explicit and independent of DOM visibility', () => {
  assert.equal(studioPresentation({ isTransit: true }).timelineKind, 'day');
  assert.equal(studioPresentation({ isTransit: true, lifetime: { opened: true, mode: 'day' } }).timelineKind, 'chronicle');
  assert.equal(studioPresentation(personal).timelineKind, 'day');
  assert.equal(studioPresentation({ ...personal, dayOpened: true }).timelineKind, 'natal-day');
  const unsupported = studioPresentation({});
  assert.equal(unsupported.lifetimeAvailable, false);
  assert.equal(unsupported.toggleEnabled, false);
  assert.equal(unsupported.lifetimeHeadingVisible, true);
  assert.equal(studioPresentation({ isTransit: true, transitEnabled: true }).toggleEnabled, true);
  assert.equal(studioPresentation({ loadFailed: true }).toggleLabel, 'Обновить страницу и загрузить летопись');
});


test('the same presentation identifies the actual timeline panel for initial loading', () => {
  assert.equal(studioPresentation({ isTransit: true }).timelinePanel, 'transit');
  assert.equal(studioPresentation({ isTransit: true, lifetime: { opened: true, mode: 'day' } }).timelinePanel, 'lifetime');
  assert.equal(studioPresentation(personal).timelinePanel, 'lifetime');
  assert.equal(studioPresentation({ ...personal, dayOpened: true }).timelinePanel, 'natal-day');
  assert.equal(studioPresentation({}).timelinePanel, null);
});
