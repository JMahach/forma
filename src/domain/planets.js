export const PLANETS = [
  ['sun', '☉', 'Солнце'], ['earth', '⊕', 'Земля'], ['moon', '☽', 'Луна'],
  ['north_node', '☊', 'Северный узел'], ['south_node', '☋', 'Южный узел'],
  ['mercury', '☿', 'Меркурий'], ['venus', '♀', 'Венера'], ['mars', '♂', 'Марс'],
  ['jupiter', '♃', 'Юпитер'], ['saturn', '♄', 'Сатурн'], ['uranus', '♅', 'Уран'],
  ['neptune', '♆', 'Нептун'], ['pluto', '♇', 'Плутон']
];

export const PLANET_IDS = Object.freeze(PLANETS.map(([id]) => id));
