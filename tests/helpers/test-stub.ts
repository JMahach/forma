// Test doubles supply only the browser/service members exercised by a test.
// Keep their supplied values checked; convert to the full port at the harness boundary.
export type TestStub<T> = T extends (...args: infer A) => infer R
  ? (...args: A) => R extends object ? Partial<R> : R
  : T extends readonly (infer Item)[] ? TestStub<Item>[]
  : T extends object ? T | { -readonly [Key in keyof T]?: TestStub<T[Key]> }
  : T;
