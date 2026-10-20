// Library records and HTTP payloads contain more than the diagram needs.
// Extract their chart data once at the boundary; names, notes and persistence
// metadata stay with the record. Manual gates need neither UTC nor activations.
const fields = ['source', 'personality', 'design', 'activations', 'utc', 'timezone', 'utcOffset', 'fold',
  'designUtc', 'designArcResidualDegrees', 'engine', 'ephemeris', 'timezoneDatabase', 'nodeModel', 'zodiac', 'verification'];

export function extractChartData(payload) {
  const data = Object.fromEntries(fields.filter(field => Object.hasOwn(payload, field)).map(field => [field, payload[field]]));
  if (Object.hasOwn(payload, 'birthDate')) data.localDate = payload.birthDate;
  if (Object.hasOwn(payload, 'birthTime')) data.localTime = payload.birthTime;
  return Object.freeze(data);
}

// Eligibility is shared by the early loading projection and the day owner.
export const canExploreNatalDay = chart => Boolean(chart?.source === 'calculated'
  && chart.id !== 'current-transit' && /^\d{4}-\d{2}-\d{2}$/.test(chart.birthDate || '')
  && String(chart.cityId ?? chart.city?.id ?? '').length > 0 && Number.isFinite(Date.parse(chart.utc)));
