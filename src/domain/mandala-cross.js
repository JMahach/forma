import { normalizeLongitude as normalize, gatePositionAtLongitude } from './gate-wheel.js';

const DESIGN_SUN_ARC = 88;
const PROFILE_TYPES = Object.freeze({
  '1/3': 'right-angle', '1/4': 'right-angle', '2/4': 'right-angle',
  '2/5': 'right-angle', '3/5': 'right-angle', '3/6': 'right-angle',
  '4/6': 'right-angle', '4/1': 'juxtaposition',
  '5/1': 'left-angle', '5/2': 'left-angle', '6/2': 'left-angle', '6/3': 'left-angle',
});
const TYPE_LABELS = Object.freeze({
  'right-angle': 'Правоугольный крест',
  juxtaposition: 'Джакстапозиционный крест',
  'left-angle': 'Левоугольный крест',
});

function position(longitude, source, planet) {
  return { source, planet, ...gatePositionAtLongitude(longitude) };
}

/**
 * Preview the Sun/Earth cross at an exact point of the existing longitude wheel.
 * The pointer is the Sun of `source`; the other Sun is exactly 88° earlier/later.
 * This matches astronomy.py's solar arc, not an approximation of 88 calendar
 * days. It does not calculate a birth date, other planets, or a named cross.
 *
 * Profile and angle categories follow Jovian's glossary entries Profile,
 * Profile Foundation, Right Angle, Left Angle, and Juxtaposition:
 * https://jovianarchive.com/pages/human-design-dictionary
 * Gate and line intervals are half-open, like server/python/astronomy.py: an exact
 * boundary belongs to the new interval. Do not round longitude for display
 * before calling this function, or narrow 4/1 transitions can disappear.
 */
export function crossAtLongitude(longitude, { source = 'personality' } = {}) {
  if (!Number.isFinite(longitude)) throw new TypeError('Longitude must be a finite number');
  if (source !== 'personality' && source !== 'design') throw new TypeError('Source must be personality or design');
  longitude = normalize(longitude);
  const personalityLongitude = normalize(longitude + (source === 'design' ? DESIGN_SUN_ARC : 0));
  const designLongitude = source === 'design' ? longitude : normalize(longitude - DESIGN_SUN_ARC);
  const positions = [
    position(personalityLongitude, 'personality', 'sun'),
    position(personalityLongitude + 180, 'personality', 'earth'),
    position(designLongitude, 'design', 'sun'),
    position(designLongitude + 180, 'design', 'earth'),
  ];
  const profile = `${positions[0].line}/${positions[2].line}`;
  const type = PROFILE_TYPES[profile];
  return { longitude, source, type, label: TYPE_LABELS[type], profile, gates: positions.map(item => item.gate), positions };
}
