import type { EventEmitter } from 'node:events';
import type { SpawnOptions } from 'node:child_process';

export interface TestWorker<Input = unknown> extends EventEmitter {
  pid?: number;
  stdout: EventEmitter & { setEncoding(encoding: string): void };
  stdin: EventEmitter & { end(value: string): void };
  kill(signal?: NodeJS.Signals): void;
  input: Input;
  killed?: NodeJS.Signals;
  signal?: NodeJS.Signals;
}
export type TestSpawner<Input = unknown> = (
  command: string, args: readonly string[], options: SpawnOptions,
) => TestWorker<Input>;
