import { MANDALA_GEOMETRY, mandalaPoint } from './mandala-geometry.js';
import { normalizeLongitude } from '../../domain/gate-wheel.js';

const { outerRadius } = MANDALA_GEOMETRY;
const glyphRadius = 10, personalityRadius = outerRadius + 12, designRadius = outerRadius + 33;
export const MANDALA_PLANET_LAYOUT = Object.freeze({
  fontSize: 14,
  glyphRadius,
  labelGap: 2,
  designRadius,
  personalityRadius,
  visualRadius: Math.max(personalityRadius, designRadius) + glyphRadius,
});

const difference = (left, right) => normalizeLongitude(left - right + 180) - 180;
const comparePlanet = (left, right) => left.planet < right.planet ? -1 : left.planet > right.planet ? 1 : 0;

// Project the ordered angles onto a minimum spacing. Pooling only overlapping
// neighbours leaves isolated labels exactly at their astronomical longitude.
function spreadAngles(angles, spacing) {
  const pools = [];
  angles.forEach((angle, index) => {
    pools.push({ first: index, last: index, sum: angle - index * spacing, count: 1 });
    while (pools.length > 1) {
      const right = pools[pools.length - 1], left = pools[pools.length - 2];
      if (left.sum / left.count <= right.sum / right.count) break;
      pools.splice(-2, 2, { first: left.first, last: right.last,
        sum: left.sum + right.sum, count: left.count + right.count });
    }
  });
  const result = [];
  for (const pool of pools) {
    for (let index = pool.first; index <= pool.last; index++) {
      result[index] = pool.count === 1 ? angles[index] : pool.sum / pool.count + index * spacing;
    }
  }
  return result;
}

function laneLongitudes(entries, radius) {
  if (entries.length < 2) return entries.map(entry => entry.longitude);
  const ordered = entries.map((entry, index) => ({ ...entry, index }))
    .sort((left, right) => left.longitude - right.longitude || comparePlanet(left, right));
  // The tiny extra clearance absorbs mandalaPoint's three-decimal rounding.
  const distance = 2 * MANDALA_PLANET_LAYOUT.glyphRadius + MANDALA_PLANET_LAYOUT.labelGap + .002;
  const spacing = 2 * Math.asin(distance / (2 * radius)) * 180 / Math.PI;
  const cuts = ordered.map((entry, index) => ({ index,
    gap: entry.longitude - ordered[(index + ordered.length - 1) % ordered.length].longitude + (index === 0 ? 360 : 0),
  })).sort((left, right) => right.gap - left.gap || left.index - right.index);

  // A cut through free space makes the circular problem a linear one. Check
  // the closing gap too: a dense group must never collide across 359° / 0°.
  for (const { index: cut } of cuts) {
    const lane = ordered.slice(cut).concat(ordered.slice(0, cut));
    const angles = lane.map((entry, index) => entry.longitude + (index >= ordered.length - cut ? 360 : 0));
    const spread = spreadAngles(angles, spacing);
    if (spread[spread.length - 1] - spread[0] > 360 - spacing + 1e-9) continue;
    const result = [];
    lane.forEach((entry, index) => {
      result[entry.index] = Math.abs(spread[index] - angles[index]) < 1e-9
        ? entry.longitude : normalizeLongitude(spread[index]);
    });
    return result;
  }
  throw new RangeError('Planet labels exceed the available mandala circumference');
}

function leaderPath(longitude, labelLongitude, radius, source) {
  const start = mandalaPoint(longitude, outerRadius + 1).join(' ');
  const delta = difference(labelLongitude, longitude);
  if (Math.abs(delta) < 1e-9) {
    // The outer design lane keeps its connecting line even without a collision.
    const endRadius = source === 'design' ? radius - MANDALA_PLANET_LAYOUT.glyphRadius - 1 : outerRadius + 3;
    return `M ${start} L ${mandalaPoint(longitude, endRadius).join(' ')}`;
  }
  // Follow the outside of the rim rather than cutting across its gate cells.
  const bendRadius = outerRadius + 2;
  const bend = mandalaPoint(longitude, bendRadius).join(' ');
  const turn = mandalaPoint(labelLongitude, bendRadius).join(' ');
  const end = mandalaPoint(labelLongitude, radius - MANDALA_PLANET_LAYOUT.glyphRadius - 1).join(' ');
  return `M ${start} L ${bend} A ${bendRadius} ${bendRadius} 0 0 ${delta > 0 ? 0 : 1} ${turn} L ${end}`;
}

// Input has already been validated by mandalaPlanetEntries. Preserve its order
// and true longitudes; only the displayed glyphs may move within their lane.
export function layoutMandalaPlanets(entries) {
  const result = new Array(entries.length);
  for (const source of ['design', 'personality']) {
    const lane = entries.map((entry, index) => ({ ...entry, index })).filter(entry => entry.source === source);
    const radius = MANDALA_PLANET_LAYOUT[`${source}Radius`];
    const longitudes = laneLongitudes(lane, radius);
    lane.forEach(({ index }, position) => {
      const entry = entries[index], labelLongitude = longitudes[position];
      const [x, y] = mandalaPoint(labelLongitude, radius);
      result[index] = { ...entry, x, y, labelLongitude,
        leaderPath: leaderPath(entry.longitude, labelLongitude, radius, source) };
    });
  }
  return result;
}
