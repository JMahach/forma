import { createMomentStorage } from './moment-storage.js';
import { packetKey, packetDate, packetBytes, dayPacket, momentPacket, mergePackets, packetCatalogue,
  catalogueHasMinute, packetMoment, packetDay } from './moment-packet.js';

// One instance per tab owns public numbers, across all tools. RAM is immediate;
// the disk catalogue tells a scale where minute samples exist without loading
// every day. Neither a cache miss nor persistence may start network or Python.
export function createMomentCache({ indexedDB, databaseName, maxMemoryBytes = 32 * 1024 * 1024,
  maxDiskBytes = 256 * 1024 * 1024, maxWriteBytes = 4 * 1024 * 1024, now = Date.now,
  storage = createMomentStorage({ indexedDB, databaseName, maxBytes: maxDiskBytes, now }) } = {}) {
  const dayViews = new WeakMap(), pinned = new Map();
  const coverage = new WeakMap();
  const memory = new Map(), diskCatalogue = new Map(), reads = new Map(), writes = new Map(), touches = new Set(), snapshots = new Map();
  let flushingPackets = new Map();
  let memoryBytes = 0, writeBytes = 0, timer = null, flushing = null, closed = false;
  const ready = storage.catalogue().then(entries => {
    for (const entry of entries || []) if (!diskCatalogue.has(entry.key)) rememberDisk(entry);
  }).catch(() => {});
  function rememberDisk(entry) {
    diskCatalogue.delete(entry.key); diskCatalogue.set(entry.key, entry);
    for (const [key, value] of diskCatalogue) {
      if (diskCatalogue.size <= 8192) break;
      if (!value.full) diskCatalogue.delete(key);
    }
  }
  function retain(packet) {
    const previous = memory.get(packet.key);
    if (previous !== packet) for (const key of snapshots.keys()) if (key.startsWith(`${packet.key}:`)) snapshots.delete(key);
    memoryBytes -= previous ? packetBytes(previous) : 0;
    memory.delete(packet.key); memory.set(packet.key, packet); memoryBytes += packetBytes(packet);
    for (const [key, oldest] of memory) {
      if (memoryBytes <= maxMemoryBytes) break;
      if (!pinned.has(key)) { memory.delete(key); memoryBytes -= packetBytes(oldest); }
    }
    return packet;
  }
  function schedule() { if (!timer && !closed) { timer = setTimeout(() => { timer = null; void flush(); }, 100); timer.unref?.(); } }
  function touch(key) { touches.add(key); if (touches.size > 256) touches.delete(touches.values().next().value); schedule(); }
  function peek(date, version) {
    const key = packetKey(date, version), packet = memory.get(key);
    if (packet) { memory.delete(key); memory.set(key, packet); touch(key); }
    return packet || null;
  }
  function available(key, disk = null) {
    // RAM can contain only a newer fragment after eviction. Pending writes
    // remain readable until persistence settles; none may shadow the others.
    for (const packet of [flushingPackets.get(key), writes.get(key), memory.get(key)]) disk = mergePackets(disk, packet);
    return disk;
  }
  async function read(date, version, contains) {
    const key = packetKey(date, version), hot = peek(date, version);
    if (hot && contains(hot)) return hot;
    const local = available(key);
    if (local && contains(local)) return retain(local);
    await ready;
    if (!reads.has(key)) reads.set(key, storage.read(key).then(packet => {
      if (packet) { rememberDisk(packetCatalogue(packet, now())); touch(key); }
      else diskCatalogue.delete(key);
      // Include rows received while the disk read was pending, even if they
      // no longer fit RAM. A failed read cannot discard local ready numbers.
      const merged = available(key, packet);
      return merged ? retain(merged) : null;
    }).catch(() => available(key)).finally(() => reads.delete(key)));
    return reads.get(key);
  }
  function remember(packet) {
    if (closed) return;
    const combined = mergePackets(memory.get(packet.key), packet);
    retain(combined);
    const queued = writes.get(packet.key), next = mergePackets(queued, packet);
    writeBytes += packetBytes(next) - (queued ? packetBytes(queued) : 0); writes.delete(packet.key); writes.set(packet.key, next);
    while (writeBytes > maxWriteBytes && writes.size) {
      const [key, oldest] = writes.entries().next().value; writes.delete(key); writeBytes -= packetBytes(oldest);
    }
    schedule();
  }
  function snapshot(packet, milliseconds) {
    if (!packet) return null;
    const key = `${packet.key}:${milliseconds}`;
    if (snapshots.has(key)) { const value = snapshots.get(key); snapshots.delete(key); snapshots.set(key, value); return value; }
    const value = packetMoment(packet, milliseconds); if (!value) return null;
    snapshots.set(key, value); if (snapshots.size > 128) snapshots.delete(snapshots.keys().next().value);
    return value;
  }
  async function flush() {
    clearTimeout(timer); timer = null;
    if (flushing) { await flushing; if (writes.size || touches.size) return flush(); return; }
    if (!writes.size && !touches.size) return;
    const batch = [...writes.values()], accessed = [...touches]; flushingPackets = new Map(writes); writes.clear(); touches.clear(); writeBytes = 0;
    flushing = storage.write(batch, accessed).then(result => {
      if (!result) return;
      for (const entry of result.changed) rememberDisk(entry);
      for (const key of result.removed) diskCatalogue.delete(key);
    }).catch(() => {}).finally(() => { flushing = null; flushingPackets = new Map(); });
    await flushing;
    if (writes.size || touches.size) return flush();
  }
  function dayView(packet) {
    if (!packet?.day) return null;
    let day = dayViews.get(packet)?.deref();
    if (!day) { day = packetDay(packet); dayViews.set(packet, new WeakRef(day)); }
    return day;
  }
  return {
    ready, flush,
    retainDay(day) {
      const key = packetKey(day.date, day.calculationVersion);
      const packet = memory.get(key);
      const full = packet?.day ? packet : mergePackets(packet, dayPacket(day));
      pinned.set(key, (pinned.get(key) || 0) + 1);
      retain(full);
      let released = false;
      return () => { if (released) return; released = true;
        const count = pinned.get(key) - 1; if (count) pinned.set(key, count); else pinned.delete(key);
        const packet = memory.get(key); if (packet) retain(packet);
      };
    },
    get memoryBytes() { return memoryBytes; },
    get catalogueSize() { return new Set([...diskCatalogue.keys(), ...memory.keys(), ...writes.keys(), ...flushingPackets.keys()]).size; },
    putDay(day) { remember(dayPacket(day)); },
    putMoment(moment, metadata) { remember(momentPacket(moment, metadata)); },
    peekDay(date, version) { const packet = peek(date, version); return dayView(packet); },
    async getDay(date, version) { const packet = await read(date, version, packet => Boolean(packet.day)); return dayView(packet); },
    hasMinute(milliseconds, version) {
      const key = packetKey(packetDate(milliseconds), version);
      if (catalogueHasMinute(diskCatalogue.get(key), milliseconds)) return true;
      for (const packet of [memory.get(key), writes.get(key), flushingPackets.get(key)]) if (packet) {
        let entry = coverage.get(packet); if (!entry) { entry = packetCatalogue(packet, 0); coverage.set(packet, entry); }
        if (catalogueHasMinute(entry, milliseconds)) return true;
      }
      return false;
    },
    peekMoment(milliseconds, version) { return snapshot(peek(packetDate(milliseconds), version), milliseconds); },
    async readMoment(milliseconds, version) { return snapshot(await read(packetDate(milliseconds), version, packet => Boolean(packetMoment(packet, milliseconds))), milliseconds); },
    async close() { closed = true; await flush(); storage.close(); },
  };
}
