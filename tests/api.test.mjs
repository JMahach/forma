import test from 'node:test';
import assert from 'node:assert/strict';

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

apiTest('private city database and repository files are not publicly served', async () => {
  for (const path of ['/data/cities.json', '/.git/config', '/calculator.py', '/.venv/pyvenv.cfg']) {
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
