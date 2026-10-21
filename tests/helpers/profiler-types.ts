import type { Profiler } from 'node:inspector';
// promisify cannot retain the overloaded protocol signatures of Session.post.
export interface ProfilerPost {
  (method: 'Profiler.takePreciseCoverage'): Promise<Profiler.TakePreciseCoverageReturnType>;
  (method: 'Profiler.startPreciseCoverage', params: Profiler.StartPreciseCoverageParameterType): Promise<unknown>;
  (method: 'Profiler.enable' | 'Profiler.stopPreciseCoverage'): Promise<unknown>;
}
