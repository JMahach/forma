import { PLANET_IDS } from '../domain/planets.js';

// One selection owner serves ordinary transit, its day slider and the archive.
// Source charts remain complete so either side can be restored without a fetch.
// Years retain individual choices. The day always shows all black planets and
// shows all red when the shared Design selection contains any planet.
export function createTransitPlanetFilter() {
  const selections = { personality: new Set(PLANET_IDS), design: new Set() };
  let expanded = false, projections = new WeakMap();
  const ordered = source => PLANET_IDS.filter(planet => selections[source].has(planet));
  const state = () => expanded
    ? { selectedPlanets: ordered('personality'), selectedDesignPlanets: ordered('design') }
    : { selectedPlanets: [...PLANET_IDS], selectedDesignPlanets: selections.design.size ? [...PLANET_IDS] : [] };
  function setPlanet(planet, enabled, source = 'personality') {
    if (!expanded || !Object.prototype.hasOwnProperty.call(selections, source)
        || !PLANET_IDS.includes(planet) || typeof enabled !== 'boolean') return false;
    const selected = selections[source];
    if (selected.has(planet) === enabled) return true;
    if (enabled) selected.add(planet); else selected.delete(planet);
    projections = new WeakMap();
    return true;
  }
  function setAllPlanets(enabled, source = 'personality') {
    if (!Object.prototype.hasOwnProperty.call(selections, source) || typeof enabled !== 'boolean') return false;
    if (!expanded && source !== 'design') return false;
    const selected = selections[source];
    if (selected.size === (enabled ? PLANET_IDS.length : 0)) return true;
    selected.clear();
    if (enabled) PLANET_IDS.forEach(planet => selected.add(planet));
    projections = new WeakMap();
    return true;
  }
  return {
    get state() { return state(); },
    get snapshot() { return { selectedPlanets: ordered('personality'), selectedDesignPlanets: ordered('design') }; },
    restore(snapshot) {
      if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return false;
      const pairs = [['personality', snapshot.selectedPlanets], ['design', snapshot.selectedDesignPlanets]];
      if (pairs.some(([, values]) => !Array.isArray(values)
          || values.length !== new Set(values).size
          || Array.from(values).some(planet => !PLANET_IDS.includes(planet)))) return false;
      const changed = pairs.some(([source, values]) => values.length !== selections[source].size
        || values.some(planet => !selections[source].has(planet)));
      if (changed) {
        for (const [source, values] of pairs) selections[source] = new Set(values);
        projections = new WeakMap();
      }
      return true;
    },
    setPlanet, setAllPlanets,
    setExpanded(value) {
      if (typeof value !== 'boolean') return false;
      if (expanded !== value) { expanded = value; projections = new WeakMap(); }
      return true;
    },
    togglePlanet(planet, source = 'personality') {
      if (!Object.prototype.hasOwnProperty.call(selections, source)) return false;
      return setPlanet(planet, !selections[source].has(planet), source);
    },
    toggleAllPlanets(source = 'personality') {
      if (!Object.prototype.hasOwnProperty.call(selections, source)) return false;
      return setAllPlanets(expanded ? selections[source].size !== PLANET_IDS.length : selections[source].size === 0, source);
    },
    filter(chart) {
      if (!chart || chart.source !== 'transit') return chart;
      if (projections.has(chart)) return projections.get(chart);
      const fullPersonality = chart.planetFilter?.activations || chart.activations?.personality || [];
      const fullDesign = chart.planetFilter?.designActivations || chart.activations?.design || [];
      const selected = state(), black = new Set(selected.selectedPlanets), red = new Set(selected.selectedDesignPlanets);
      const personality = fullPersonality.filter(entry => black.has(entry.planet)).map(entry => ({ ...entry }));
      const design = fullDesign.filter(entry => red.has(entry.planet)).map(entry => ({ ...entry }));
      const result = { ...chart,
        personality: [...new Set(personality.map(entry => entry.gate))].sort((a, b) => a - b),
        design: [...new Set(design.map(entry => entry.gate))].sort((a, b) => a - b),
        activations: { ...chart.activations, personality, design },
        planetFilter: { ...selected, perPlanetControls: expanded,
          activations: fullPersonality, designActivations: fullDesign } };
      // Reuse each live chart within this selection without retaining old days.
      // A projection carries its full rows and is already filtered until reset.
      projections.set(chart, result);
      projections.set(result, result);
      return result;
    },
  };
}
