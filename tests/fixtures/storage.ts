import type { ChartRecord } from '../../shared/chart-types.ts';
import type { ChartStorage } from '../../src/data/storage.ts';
import { readCharts as read, writeChartChanges as write, deleteChart as remove } from '../../src/data/storage.ts';
export * from '../../src/data/storage.ts';

// Storage tests also exercise old records and deliberately incomplete browser ports.
// The real validators still run; these aliases only describe those test inputs.
type TestStorage = Pick<ChartStorage, 'getItem'> & Partial<Omit<ChartStorage, 'getItem'>>;
type LegacyRecord = Omit<ChartRecord, 'source'> & { source?: ChartRecord['source'] };
export const readCharts = read as (storage: TestStorage, key?: string, onInvalid?: (key: string) => void) => ReturnType<typeof read>;
export const writeChartChanges = write as (storage: TestStorage, charts: readonly LegacyRecord[], previous: readonly LegacyRecord[]) => number;
export const deleteChart = remove as (storage: TestStorage, charts: LegacyRecord[], id: string,
  onCleanupError?: (message: string) => void, onInvalid?: (key: string) => void) => ReturnType<typeof remove>;
