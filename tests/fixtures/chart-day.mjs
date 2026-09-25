export function chartDayFixture({ date = '2026-09-24', timezone = 'UTC', samples = 1440, segments } = {}) {
  const spans = segments || [{ index: 0, startUtc: `${date}T00:00:00Z`, utcOffset: 'UTC+00:00', offsetSeconds: 0, fold: 0 }];
  return {
    date, timezone, samples, startUtc: spans[0].startUtc, stepSeconds: 60, segments: spans,
    engine: 'Swiss Ephemeris', ephemeris: 'test', timezoneDatabase: 'test', nodeModel: 'true', zodiac: 'tropical-geocentric-apparent',
    columns: Array.from({ length: 24 }, (_, column) => Float64Array.from({ length: samples }, (_, index) =>
      column < 22 ? (column * 15 + index / 10000) % 360 : column === 22 ? Date.parse(spans[0].startUtc) / 1000 - 88 * 86400 + index * 60 : 1e-12)),
  };
}

export function personalChartFixture(overrides = {}) {
  return {
    id: 'saved-person', name: 'Saved person', source: 'calculated', birthDate: '2026-09-24',
    birthTime: '12:34:45', utc: '2026-09-24T12:34:45Z', utcOffset: 'UTC+00:00', timezone: 'UTC', cityId: 'test-city',
    personality: [1, 41], design: [8, 31], createdAt: '2026-09-25T01:00:00Z', updatedAt: '2026-09-25T01:00:00Z',
    ...overrides,
  };
}
