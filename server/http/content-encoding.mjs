// HTTP transport policy, independent of either public transit or private natal
// data. A null result lets each endpoint provide its own 406 response.
export function negotiateEncoding(header) {
  if (!header) return 'identity';
  const accepted = new Map(String(header).toLowerCase().split(',').map(part => {
    const [name, ...parameters] = part.trim().split(';');
    const quality = parameters.map(value => value.trim()).find(value => value.startsWith('q='));
    const q = quality ? Number(quality.slice(2)) : 1;
    return [name, Number.isFinite(q) && q >= 0 && q <= 1 ? q : 0];
  }));
  const quality = name => accepted.get(name) ?? (name === 'identity' ? accepted.get('*') === 0 ? 0 : 1 : accepted.get('*') ?? 0);
  const supported = ['br', 'gzip', 'identity'].map(name => ({ name, q: quality(name) })).filter(item => item.q > 0);
  return supported.length ? supported.reduce((best, item) => item.q > best.q ? item : best).name : null;
}
