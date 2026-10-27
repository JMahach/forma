import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ComputeQueue } from './compute-queue.ts';
import { runJsonWorker } from './json-worker.ts';

const runtimeRoot = fileURLToPath(new URL('../../', import.meta.url));
const reasons = ['complete', 'missing', 'unsupported', 'unsafe_path', 'unsafe_entry', 'io_error', 'invalid_input'] as const;
type MigrationReason = typeof reasons[number] | 'unavailable';
export interface TransitCacheMigration {
  /** Null means the helper failed before a confirmed count could be returned. */
  removed: number | null;
  blocked: number;
  reason: MigrationReason;
}

/** Server configuration only. Never accepts an HTTP path or falls back to path-based deletion. */
export async function migrateTransitCache(directory: string, computeQueue?: ComputeQueue): Promise<TransitCacheMigration> {
  const unavailable = () => new Error('Transit cache migration unavailable');
  try {
    return await runJsonWorker({
      root: runtimeRoot, script: 'transit_cache_cleanup.py', input: {directory: path.isAbsolute(directory) ? directory : process.cwd() + path.sep + directory}, computeQueue,
      timeoutMs: 30000, maxOutput: 1024, unavailable, timeoutError: unavailable,
      validate(value): TransitCacheMigration {
        const result = value as Partial<TransitCacheMigration> | null;
        if (!result || !Number.isSafeInteger(result.removed) || result.removed! < 0
          || !Number.isSafeInteger(result.blocked) || result.blocked! < 0
          || !reasons.includes(result.reason as typeof reasons[number])) throw unavailable();
        return {removed: result.removed!, blocked: result.blocked!, reason: result.reason!};
      },
    });
  } catch { return {removed: null, blocked: 1, reason: 'unavailable'}; }
}
