const snapshots=new WeakSet<object>();

/** Mark only an owned snapshot: accepted objects and their children cannot change in place. */
export function immutableSnapshot<T extends object>(value:T):T {
 if(snapshots.has(value))return value;
 snapshots.add(value);
 for(const child of Object.values(value))if(child!==null && typeof child==='object')immutableSnapshot(child);
 return Object.freeze(value);
}
export function isImmutableSnapshot(value:unknown):value is object {
 return value!==null && typeof value==='object' && snapshots.has(value);
}
