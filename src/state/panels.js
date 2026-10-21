// One tab-level owner for panel visibility; views only project this state.
export function createPanelState() {
  let left = false, right = false, restoring = false, exclusive = false;
  let lastExplicitOpened = null;
  let leftRequestDuringRestore = null, rightRequestDuringRestore = null;
  const listeners = new Set();
  const snapshot = () => ({ left, right });
  function restore(value) {
    let nextLeft = leftRequestDuringRestore ?? (value?.left === true);
    let nextRight = rightRequestDuringRestore ?? (value?.right === true);
    if (exclusive && nextLeft && nextRight) {
      if (lastExplicitOpened === 'right') nextLeft = false;
      else nextRight = false;
    }
    if (left === nextLeft && right === nextRight) return;
    left = nextLeft; right = nextRight;
    for (const listener of listeners) listener(snapshot());
  }
  return {
    get left() { return left; }, get right() { return right; },
    get snapshot() { return snapshot(); },
    setExclusive(value) {
      const next = value === true;
      if (exclusive === next) return;
      exclusive = next;
      if (exclusive && restoring && (leftRequestDuringRestore === true || rightRequestDuringRestore === true)) {
        if (lastExplicitOpened === 'right') leftRequestDuringRestore = false;
        else rightRequestDuringRestore = false;
      }
      restore(snapshot());
    },
    setLeft(value) {
      const opened = value === true;
      if (opened) lastExplicitOpened = 'left';
      if (restoring) {
        leftRequestDuringRestore = opened;
        if (exclusive && opened) rightRequestDuringRestore = false;
      }
      restore({ left: opened, right: exclusive && opened ? false : right });
    },
    setRight(value, { automatic = false } = {}) {
      if (automatic && (exclusive && left || restoring && rightRequestDuringRestore !== null)) return;
      const opened = value === true;
      if (opened && !automatic) lastExplicitOpened = 'right';
      if (restoring && !automatic) {
        rightRequestDuringRestore = opened;
        if (exclusive && opened) leftRequestDuringRestore = false;
      }
      restore({ left: exclusive && opened ? false : left, right: opened });
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
