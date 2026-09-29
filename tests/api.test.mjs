import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';

// Explicit opt-in: the normal offline test suite must not require a running server.
// Start the application separately, then run RUN_API_TESTS=1 npm test.
const apiTest = process.env.RUN_API_TESTS === '1' ? test : test.skip;
const base = process.env.API_TEST_BASE_URL || 'http://127.0.0.1:4173';
const birth = {
  mode: 'natal', name: 'API regression test', date: '1990-06-15', time: '14:30',
  cityId: '524901', cityName: 'Москва'
};

async function request(path, options = {}) {
  const response = await fetch(new URL(path, base), { ...options, signal: AbortSignal.timeout(20000) });
  const body = await response.text();
  return { status: response.status, headers: response.headers, body, json: () => JSON.parse(body) };
}

const post = (value, headers = {}) => request('/api/calculate', {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(value)
});

apiTest('the browser can load the selection state module and its dependency', async () => {
  const module = await request('/src/selection/selection-state.js');
  assert.equal(module.status, 200);
  assert.match(module.headers.get('content-type'), /javascript/);
  assert.match(module.body, /export function createSelectionState\(/);
  assert.match(module.body, /from '\.\.\/domain\/topology\.js'/);
  const graph = await request('/src/domain/topology.js');
  assert.equal(graph.status, 200);
  assert.match(graph.headers.get('content-type'), /javascript/);
});

apiTest('the page loads the complete frontend module graph through public source URLs', async () => {
  const page = await request('/');
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type'), /html/);
  assert.match(page.body, /<svg id="chartLoadingArt"/, 'loading art is present before application JavaScript');
  assert.doesNotMatch(page.body, /<!-- chart-loading-placeholder -->/);
  const entryPoints = [...page.body.matchAll(/<script\b([^>]*)>/g)]
    .filter(([, attributes]) => /\btype=["']module["']/.test(attributes))
    .map(([, attributes]) => attributes.match(/\bsrc=["']([^"']+)["']/)?.[1]);
  assert.deepEqual(entryPoints, ['/src/startup.js']);
  const story = await request('/love');
  assert.equal(story.status, 200);
  assert.match(story.headers.get('content-type'), /html/);
  assert.match(story.body, /src="\/src\/stories\/vessel-of-love.js"/);
  const pending = [...entryPoints, '/src/stories/vessel-of-love.js'].map(path => new URL(path, base)), visited = new Set();
  while (pending.length) {
    const url = pending.pop();
    assert.equal(url.origin, new URL(base).origin, 'frontend modules stay on the application origin');
    assert.ok(url.pathname.startsWith('/src/') || url.pathname.startsWith('/shared/day-packets/'), `${url.pathname} uses the public source boundary`);
    if (visited.has(url.pathname)) continue;
    visited.add(url.pathname);
    const module = await request(url);
    assert.equal(module.status, 200, url.pathname);
    assert.match(module.headers.get('content-type'), /javascript/, url.pathname);
    const patterns = [
      /^\s*import\s+(?:[^'";]+?\s+from\s+)?['"]([^'"]+)['"]/gm,
      /^\s*export\s+(?:\*|\{[^}]*\})\s+from\s+['"]([^'"]+)['"]/gm,
      /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    ];
    for (const pattern of patterns) {
      for (const [, dependency] of module.body.matchAll(pattern)) pending.push(new URL(dependency, url));
    }
  }
  const sourceModules = (directory = new URL('../src/', import.meta.url), prefix = '/src/') =>
    readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory()
      ? sourceModules(new URL(`${entry.name}/`, directory), `${prefix}${entry.name}/`)
      : entry.name.endsWith('.js') ? [`${prefix}${entry.name}`] : []);
  const loadingGenerator = '/src/scene/loading-placeholder.js';
  assert.ok(!visited.has(loadingGenerator), 'the server/build generator is not browser-reachable');
  assert.equal((await request(loadingGenerator)).status, 404, 'the loading generator remains private');
  assert.deepEqual([...visited].sort(), [...sourceModules().filter(file => file !== loadingGenerator), ...sourceModules(new URL('../shared/day-packets/', import.meta.url), '/shared/day-packets/')].sort(), 'every frontend module is reachable and publicly loadable');
  const styles = await request('/styles.css');
  assert.equal(styles.status, 200);
  assert.match(styles.headers.get('content-type'), /css/);
});

apiTest('city API finds Moscow by Russian name and returns identity and timezone', async () => {
  const response = await request(`/api/cities?q=${encodeURIComponent('Москва')}`);
  assert.equal(response.status, 200);
  const cities = response.json().cities;
  assert.ok(cities.length > 0 && cities.length <= 12);
  const moscow = cities.find(city => city.id === '524901');
  assert.ok(moscow, 'Moscow must be among the suggestions');
  assert.equal(moscow.name, 'Москва');
  assert.equal(moscow.country, 'RU');
  assert.equal(moscow.timezone, 'Europe/Moscow');
  assert.equal(typeof moscow.latitude, 'number');
  assert.equal(typeof moscow.longitude, 'number');
  assert.match(response.headers.get('cache-control'), /no-store/);
});

apiTest('city API matches a Latin alias and does not return the whole database for a short query', async () => {
  const latin = await request('/api/cities?q=Moskva');
  assert.equal(latin.status, 200);
  assert.ok(latin.json().cities.some(city => city.id === '524901'));
  for (const query of ['', 'M']) {
    const response = await request(`/api/cities?q=${query}`);
    assert.equal(response.status, 200);
    assert.deepEqual(response.json().cities, []);
  }
});

apiTest('natal calculation uses historical Moscow UTC+4 and produces 26 activations', async () => {
  const response = await post(birth);
  assert.equal(response.status, 200, response.body);
  const { chart } = response.json();
  assert.equal(chart.utc, '1990-06-15T10:30:00Z');
  assert.equal(chart.utcOffset, 'UTC+04:00');
  assert.equal(chart.timezone, 'Europe/Moscow');
  assert.equal(chart.cityId, '524901');
  assert.equal(chart.birthPlace, 'Москва');
  assert.equal(chart.source, 'calculated');
  assert.equal(chart.activations.personality.length, 13);
  assert.equal(chart.activations.design.length, 13);
  assert.ok(chart.designUtc);
  assert.ok(chart.designArcResidualDegrees < 1e-7);
  assert.match(chart.engine, /Swiss Ephemeris/);
  assert.match(response.headers.get('cache-control'), /no-store/);
});

apiTest('New York fall-back returns 422 and both offsets until a fold is chosen', async () => {
  const input = { ...birth, date: '2024-11-03', time: '01:30', cityId: '5128581', cityName: 'New York City' };
  const ambiguous = await post(input);
  assert.equal(ambiguous.status, 422, ambiguous.body);
  const details = ambiguous.json();
  assert.equal(details.error, 'ambiguous_time');
  assert.equal(details.choices.length, 2);
  assert.deepEqual(details.choices.map(choice => choice.fold), [0, 1]);
  const moments = [];
  for (const fold of [0, 1]) {
    const selected = await post({ ...input, fold });
    assert.equal(selected.status, 200, selected.body);
    assert.equal(selected.json().chart.fold, fold);
    moments.push(Date.parse(selected.json().chart.utc));
  }
  assert.equal(moments[1] - moments[0], 3600000);
});

apiTest('New York spring-forward gap and impossible calendar dates are rejected', async () => {
  const gap = await post({ ...birth, date: '2024-03-10', time: '02:30', cityId: '5128581' });
  assert.equal(gap.status, 422, gap.body);
  assert.equal(gap.json().error, 'nonexistent_time');
  const invalid = await post({ ...birth, date: '2023-02-29' });
  assert.equal(invalid.status, 422, invalid.body);
  assert.equal(invalid.json().error, 'invalid_datetime');
});

apiTest('current moment calculation returns 13 live transit activations and no design', async () => {
  const before = Math.floor(Date.now() / 1000) * 1000;
  const response = await post({ mode: 'transit' });
  const after = Date.now();
  assert.equal(response.status, 200, response.body);
  const { chart } = response.json();
  assert.equal(chart.source, 'transit');
  assert.equal(chart.activations.personality.length, 13);
  assert.deepEqual(chart.activations.design, []);
  assert.deepEqual(chart.design, []);
  assert.equal(chart.designUtc, null);
  assert.ok(Date.parse(chart.utc) >= before && Date.parse(chart.utc) <= after);
});

apiTest('unknown city cannot bypass the server catalogue with a forged city object', async () => {
  const response = await post({
    ...birth, cityId: 'not-a-real-city',
    city: { id: 'not-a-real-city', name: 'Москва', timezone: 'UTC' }
  });
  assert.equal(response.status, 422, response.body);
  assert.equal(response.json().error, 'city_required');
});

apiTest('valid city identity overrides a forged timezone and arbitrary display name', async () => {
  const response = await post({
    ...birth, cityName: '<script>not an alias</script>',
    city: { id: '524901', name: 'Москва', timezone: 'UTC' }
  });
  assert.equal(response.status, 200, response.body);
  const { chart } = response.json();
  assert.equal(chart.timezone, 'Europe/Moscow');
  assert.equal(chart.utc, '1990-06-15T10:30:00Z');
  assert.doesNotMatch(chart.birthPlace, /<script>/);
});

apiTest('private server, data, tests and environment files are not publicly served', async () => {
  for (const path of [
    '/server/server.mjs', '/server/python/calculator.py', '/server/', '/server/packets/encode.mjs', '/server/packets/compression.mjs', '/server/runtime/json-worker.mjs',
    '/data/cities.json', '/data/', '/.git/config', '/calculator.py',
    '/tests/api.test.mjs', '/tests/fixtures/selection-before-refactor.js', '/tests/previews/activation-preview.mjs', '/tests/',
    '/.venv/pyvenv.cfg', '/.venv/', '/scripts/prepare-cities.py',
    '/app.js', '/bodygraph.js', '/selection-state.js', '/graph-data.js',
  ]) {
    const response = await request(path);
    assert.equal(response.status, 404, path);
  }
});

apiTest('cross-origin API requests are rejected', async () => {
  const headers = { Origin: 'https://unrelated.example' };
  const search = await request('/api/cities?q=Moscow', { headers });
  assert.equal(search.status, 403, search.body);
  assert.equal(search.json().error, 'origin');
  const calculation = await post(birth, headers);
  assert.equal(calculation.status, 403, calculation.body);
  assert.equal(calculation.json().error, 'origin');
});

apiTest('calculation API rejects malformed JSON, non-object requests, and unsupported content types', async () => {
  const malformed = await request('/api/calculate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{invalid' });
  assert.equal(malformed.status, 400);
  assert.equal(malformed.json().error, 'invalid_json');
  for (const input of [null, []]) {
    const response = await post(input);
    assert.equal(response.status, 400);
    assert.equal(response.json().error, 'invalid_request');
  }
  const wrongType = await request('/api/calculate', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' });
  assert.equal(wrongType.status, 415);
});
