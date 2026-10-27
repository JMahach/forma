import test from 'node:test';
import assert from 'node:assert/strict';
import { studioPresentation } from '../src/ui/studio-presentation.ts';
import { createChartSession, createChartExploration } from './fixtures/chart-session.ts';
import { createReturnsController } from './fixtures/returns.ts';
import { createNatalDayExplorer } from '../src/state/natal-day.ts';
import { libraryRecordAtMinute, natalDayFixture, personalChartFixture } from './fixtures/natal-day.ts';

const personal = { personalAvailable: true, lifetime: { opened: true, mode: 'lifetime' as const }, returnsOpened: true };
test('an open personal Returns list is independent of Lifetime readiness', () => {
  assert.equal(studioPresentation(personal).returnsVisible, true);
  for (const change of [{ lifetime: null },
    { lifetime: { opened: false, mode: 'lifetime' as const } }, { lifetime: { opened: true, mode: 'day' as const } }] as const) {
    const view = studioPresentation({ ...personal, ...change });
    assert.equal(view.personalTimelineVisible, false);
    assert.equal(view.returnsVisible, true);
  }
  assert.equal(studioPresentation({...personal,personalAvailable:false}).returnsVisible,false);
  const closed = studioPresentation({ ...personal, returnsOpened: false });
  assert.equal(closed.personalTimelineVisible, true);
  assert.equal(closed.returnsVisible, false);
});
test('pending tool intent does not open the list, while an explicit list opening needs no rail', () => {
  const input={personalAvailable:true,returnsEnabled:true};
  const view = studioPresentation(input);
  assert.equal(view.toggleEnabled, true);
  assert.equal(view.returnsVisible, false);
  assert.equal(view.lifetimeAvailable, true);
  assert.equal(view.lifetimeHeadingVisible, false);
  assert.equal(view.toggleLabel, 'Возвраты');
  assert.equal(studioPresentation({...input,returnsOpened:true}).returnsVisible,true);
});

test('Day and close commands close the Returns owner before presentation is derived', async () => {
  const natal=libraryRecordAtMinute(natalDayFixture(),754,personalChartFixture());
  const returns=createReturnsController({client:{events:async()=>({events:[]})}});
  const day=createNatalDayExplorer({dayClient:{getDay:async()=>natalDayFixture()}});
  const session=createChartSession({store:{get:id=>id===natal.id?natal:null,has:id=>id===natal.id},getReturns:()=>returns,getNatalDay:()=>day});
  const exploration=createChartExploration({session,getReturns:()=>returns,getNatalDay:()=>day,getLifetime:()=>null,getTransit:()=>null,loadLifetime:async()=>null});
  session.select(natal.id);exploration.selected();
  const view=()=>studioPresentation({personalAvailable:returns.available,returnsOpened:returns.opened,dayOpened:day.state.opened});
  await returns.open();assert.equal(view().returnsVisible,true);
  await exploration.openDay();
  assert.equal(day.state.opened,true);assert.equal(returns.opened,false);
  assert.equal(view().returnsVisible,false);assert.equal(view().timelinePanel,'natal-day');
  await returns.open();assert.equal(view().returnsVisible,true);
  exploration.closeScales();
  assert.equal(day.state.opened,false);assert.equal(returns.opened,false);
  assert.equal(view().returnsVisible,false);assert.equal(view().timelinePanel,null);
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
