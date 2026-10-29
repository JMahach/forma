import test from 'node:test';
import assert from 'node:assert/strict';
import { createApplication } from '../src/application/application.ts';
import { createNavigation } from '../src/platform/browser/navigation.ts';
import { appRoutePath } from '../shared/app-routes.ts';
import type { AppRoute } from '../shared/app-routes.ts';
import type { NavigationPort, NavigationSnapshot, NavigationOrigin } from '../src/application/ports.ts';

function fixture(adapter: 'memory' | 'browser', pathname = '/account') {
  const location = {pathname}, events = new EventTarget();
  const history = {
    pushState(_state: unknown, _title: string, url?: string | URL | null) { location.pathname = String(url); },
    replaceState(_state: unknown, _title: string, url?: string | URL | null) { location.pathname = String(url); },
  };
  let snapshot: NavigationSnapshot = {route: {kind: 'account'}, revision: 0};
  const listeners = new Set<(snapshot: NavigationSnapshot, origin: NavigationOrigin) => void>();
  const memory: NavigationPort & {destroy(): void} = {
    get snapshot() {return snapshot;},
    isCurrent(value) {return value === snapshot;},
    navigate(route: AppRoute, {origin = 'external'} = {}) {
      const path = appRoutePath(route);
      if (path === location.pathname) return false;
      location.pathname = path;
      snapshot = {route, revision: snapshot.revision + 1};
      for (const listener of listeners) listener(snapshot, origin);
      return true;
    },
    subscribe(listener) {listeners.add(listener); return () => {listeners.delete(listener);};},
    destroy() {listeners.clear();},
  };
  const navigation = adapter === 'browser' ? createNavigation({location, history, events}) : memory;
  const reads: {signal: AbortSignal; release: () => void}[] = [];
  const applied: string[] = [], failures: unknown[] = [];
  let disposals = 0;
  const createRuntime = () => createApplication({runtimeId:crypto.randomUUID(),navigation, route: request => ({
    enter() {},
    prepare(signal) { return new Promise<void>(release => reads.push({signal, release})); },
    apply() { applied.push(request.snapshot.route!.kind); },
    async failed(error) { failures.push(error); },
    settled() {},
    dispose() { disposals++; },
  })});
  const application = createRuntime();
  return {application, createRuntime, navigation, reads, applied, failures, location, get disposals() {return disposals;}};
}

for (const adapter of ['memory', 'browser'] as const) {
test(`${adapter}: route replacement aborts its reader, remains responsive, and ignores a late result`, async () => {
  const h = fixture(adapter); h.application.start();
  const first = h.application.requestRoute(h.navigation.snapshot);
  assert.equal(h.reads.length, 1);
  h.navigation.navigate({kind: 'transit'});
  assert.equal(h.reads[0].signal.aborted, true);
  assert.equal(h.disposals, 1);
  assert.equal(h.reads.length, 2);
  h.reads[0].release(); await first;
  assert.deepEqual(h.applied, []);
  h.reads[1].release(); await h.application.requestRoute(h.navigation.snapshot);
  assert.deepEqual(h.applied, ['transit']);
  await h.application.stop(); h.navigation.destroy();
});

test(`${adapter}: repeated intent and publishing an already accepted address do not read again`, async () => {
  const h = fixture(adapter); h.application.start();
  const first = h.application.requestRoute(h.navigation.snapshot);
  const same = h.application.requestRoute(h.navigation.snapshot);
  assert.equal(h.reads.length, 1);
  h.application.send({type: 'RoutePublished', route: {kind: 'chart', id: '1234567890'}, replace: true});
  await Promise.all([first, same]);
  assert.equal(h.reads[0].signal.aborted, true);
  assert.equal(h.reads.length, 1);
  assert.equal(h.location.pathname, '/chart/1234567890');
  h.reads[0].release(); await Promise.resolve();
  assert.deepEqual(h.applied, []);
  await h.application.stop(); h.navigation.destroy();
});

test(`${adapter}: stop releases the navigation subscription and prevents an old runtime from applying`, async () => {
  const h = fixture(adapter); h.application.start();
  const first = h.application.requestRoute(h.navigation.snapshot);
  assert.equal(h.reads.length, 1);
  await h.application.stop(); await h.application.stop(); await first;
  assert.equal(h.reads[0].signal.aborted, true);
  h.reads[0].release(); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(h.applied, []);
  h.navigation.navigate({kind: 'transit'});
  assert.equal(h.reads.length, 1);
  assert.equal(h.application.view.lifecycle, 'stopped');
  assert.equal(h.disposals, 1);
  const replacement = h.createRuntime(); replacement.start();
  const restored = replacement.requestRoute(h.navigation.snapshot);
  assert.equal(h.reads.length, 2);
  h.reads[1].release(); await restored;
  assert.deepEqual(h.applied, ['transit']);
  await replacement.stop();
  assert.equal(h.disposals, 2);
  h.navigation.destroy();
});

}
