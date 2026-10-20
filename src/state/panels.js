// One tab-level owner for independent panels; views only project this state.
export function createPanelState() {
  let left = false, right = false, restoring = false;
  let leftRequestDuringRestore = null, rightRequestDuringRestore = null;
  const listeners = new Set();
  const snapshot = () => ({ left, right });
  function restore(value) {
    const nextLeft = leftRequestDuringRestore ?? (value?.left === true);
    const nextRight = rightRequestDuringRestore ?? (value?.right === true);
    if (left === nextLeft && right === nextRight) return;
    left = nextLeft; right = nextRight;
    for (const listener of listeners) listener(snapshot());
  }
  return {
    get left() { return left; }, get right() { return right; },
    get snapshot() { return snapshot(); },
    setLeft(value) {
      if (restoring) leftRequestDuringRestore = value === true;
      restore({ left: value, right });
    },
    setRight(value, { automatic = false } = {}) {
      if (restoring && automatic && rightRequestDuringRestore !== null) return;
      if (restoring && !automatic) rightRequestDuringRestore = value === true;
      restore({ left, right: value });
    },
    // Early commands survive the same restoration passing from startup to app.
    beginRestore() {
      if (restoring) return;
      restoring = true; leftRequestDuringRestore = rightRequestDuringRestore = null;
    },
    finishRestore() { restoring = false; leftRequestDuringRestore = rightRequestDuringRestore = null; },
    get restoring() { return restoring; },
    get rightRequestDuringRestore() { return rightRequestDuringRestore; },
    restore,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
  };
}
