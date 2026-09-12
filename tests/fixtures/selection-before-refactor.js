// Deliberately frozen before the selection-module refactor on 2026-09-12.
// Independent characterization oracle: never regenerate these sources from
// selection.js or from a refactored app.js to make an equivalence test pass.
// Source app.js SHA-256: 1e112e0e4a0a94182ca1bb71db1f48853293d258605c395cfb5746edfe39fdb2
// The original bodies are preserved exactly, including their UI side effects.

// Function.toString() keeps the exact captured text while leaving the oracle
// readable here. These functions are never called in this fixture's module.

export const changeChartSource = (function changeChart(id) {
  activationPopover.close();
  hoverPreview?.clear({ notify: false });
  selectedChartId = id;
  liveWanted = id === 'current-transit';
  selection = null;
  selectedActivation = null;
  selectedItems = [];
  // Chart content changes; the shared camera does not.
  updatePage();
  closeLibrary();
}).toString();

export const chooseSource = (function choose(value) {
  const next = { type: value.type, id: value.type === 'gate' ? Number(value.id) : value.id };
  const activation = value.type === 'gate' ? value.activation || null : null;
  const index = selectedItems.findIndex(item => item.type === next.type && item.id === next.id);
  const gateCenter = next.type === 'gate' ? GATES.find(gate => gate.id === next.id)?.center : null;
  const subtractFromCenter = value.additive && gateCenter
    && selectedItems.some(item => item.type === 'center' && item.id === gateCenter);
  const repeated = value.additive ? index !== -1 || Boolean(subtractFromCenter)
    : selectedItems.length === 1 && index === 0 && selectedActivation === activation;
  const item = { ...next, ...(activation ? { activation } : {}) };
  activationPopover.close();
  if (subtractFromCenter) {
    // A partial center becomes individual gate selections, so its remaining
    // gates can be edited independently and no hidden full-center owner remains.
    const expanded = selectedItems.flatMap(selected => {
      if (selected.type === 'gate' && selected.id === next.id) return [];
      if (selected.type !== 'center' || selected.id !== gateCenter) return [selected];
      return GATES.filter(gate => gate.center === gateCenter && gate.id !== next.id)
        .map(gate => selectedItems.find(existing => existing.type === 'gate' && existing.id === gate.id)
          || { type: 'gate', id: gate.id });
    });
    selectedItems = [...new Map(expanded.map(selected => [`${selected.type}:${selected.id}`, selected])).values()];
  } else {
    selectedItems = value.additive
      ? repeated ? selectedItems.filter((_, position) => position !== index) : [...selectedItems, item]
      : repeated ? [] : [item];
  }
  const primary = selectedItems.at(-1);
  selection = primary ? { type: primary.type, id: primary.id } : null;
  selectedActivation = primary?.activation || null;
  renderGraph();
  if (activation && !repeated && selectedItems.length === 1) activationPopover.show(chart(), activation);
}).toString();

export const clearSelectionSource = (function clearSelection() {
  activationPopover.close();
  hoverPreview?.clear({ notify: false });
  selection = null;
  selectedActivation = null;
  selectedItems = [];
  renderGraph();
}).toString();
