import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSharedChartStudy } from './helpers/preview/shared-chart-preview.ts';
function harness() {
  const jobs: Array<() => void> = [];
  const study = createSharedChartStudy(() => {}, callback => {
    jobs.push(callback); return jobs.length as unknown as ReturnType<typeof setTimeout>;
  }, () => {});
  return { study, flush: () => jobs.splice(0).forEach(job => job()) };
}
test('healthy click completes once, saved cards cannot add again', () => {
  const { study, flush } = harness(); study.add(); study.add();
  assert.equal(study.state.pending, true); flush();
  assert.equal(study.state.kind, 'saved'); assert.equal(study.state.pending, false);
  study.add(); assert.equal(study.state.pending, false);
});
test('offline click does not queue an automatic write on reconnection', () => {
  const { study, flush } = harness(); study.setConnection('offline'); study.add();
  assert.equal(study.state.notice, 'offline'); assert.equal(study.state.pending, false);
  study.setConnection('online'); flush(); assert.equal(study.state.kind, 'temporary');
});
test('server queue continues on recovery; lost connection keeps the pending action', () => {
  const { study, flush } = harness(); study.setConnection('server'); study.add(); flush();
  assert.equal(study.state.pending, true); study.setConnection('offline'); flush();
  assert.equal(study.state.kind, 'temporary'); study.setConnection('online'); flush();
  assert.equal(study.state.kind, 'saved');
});
test('cancel and card switch invalidate even callbacks that arrived late', () => {
  const { study, flush } = harness(); study.add(); study.cancel(); flush();
  assert.equal(study.state.kind, 'temporary');
  study.add(); study.setKind('temporary'); flush(); assert.equal(study.state.kind, 'temporary');
  study.setConnection('server'); study.add(); study.cancel(); study.setConnection('online'); flush();
  assert.equal(study.state.kind, 'temporary');
});
