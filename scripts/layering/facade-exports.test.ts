// Named-export enumeration, tested directly: what `readNamedExports` reports
// for each export FORM, independently of the R11 boundary rules that consume
// it.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readNamedExports } from './facade-exports.ts';

test('readNamedExports collects re-export and direct-declaration forms, resolving aliases', () => {
  const source = [
    "export { a, b } from './x.ts';",
    "export type { C, D } from './y.ts';",
    "export { e as f } from './z.ts';",
    "export type { g as h } from './z.ts';",
    'export function i() {}',
    'export const j = 1;',
    'export type K = string;',
    'export interface L {}',
    "export {\n  m,\n  n,\n} from './multi.ts';",
  ].join('\n');
  assert.deepEqual(
    readNamedExports(source),
    ['D', 'C', 'K', 'L', 'a', 'b', 'f', 'h', 'i', 'j', 'm', 'n'].sort(),
  );
});

test('readNamedExports never reports the original name behind an `as` alias', () => {
  const source = "export { internalOnly as publicName } from './x.ts';";
  const names = readNamedExports(source);
  assert.deepEqual(names, ['publicName']);
  assert.ok(!names.includes('internalOnly'));
});

test('readNamedExports resolves `export * as ns` to its one real bound name', () => {
  // Unlike bare `export *`, this binds exactly one importable name (`ns`) —
  // enumerable, not a widening blind spot.
  const source = "export * as ns from './x.ts';";
  assert.deepEqual(readNamedExports(source), ['ns']);
});

// #1555 review P1 (second pass, "the gate also ignores export-star
// declarations, so it can miss future widening"): a facade pinned to an
// exact named-export list must not silently accept a form that widens its
// real surface with no enumerable name at all. These two forms throw instead
// of contributing nothing to the list — plant-verified (temporarily reverted
// to a no-op, confirmed both tests failed, restored) rather than merely
// asserted.
test('readNamedExports rejects a bare `export *` re-export', () => {
  const source = "export { runAdReplay } from './step-loop.ts';\nexport * from './leak.ts';\n";
  assert.throws(() => readNamedExports(source), /export \* from/);
});

test('readNamedExports rejects a default export', () => {
  assert.throws(() => readNamedExports('export default function leak() {}'), /export default/);
  assert.throws(() => readNamedExports('export default 42;'), /export default/);
});

test('readNamedExports reports `export { default as x }` as the named symbol x', () => {
  // The one form that sits between the two rejection rules above: the LOCAL
  // name is `default`, but what it binds in this module — and the only thing
  // a consumer can import — is `x`. Enumerable, so it must be reported, not
  // thrown; and `default` must never appear in the list.
  const names = readNamedExports("export { default as x, b } from './y.ts';");
  assert.deepEqual(names, ['b', 'x']);
  assert.ok(!names.includes('default'));
});

test('readNamedExports collects a local `export { … }` list with no `from`', () => {
  // The re-export tests above all carry a `from`; a façade that declares
  // first and exports at the bottom is the same public surface.
  assert.deepEqual(
    readNamedExports('const a = 1;\ntype T = string;\nexport { a };\nexport type { T };'),
    ['T', 'a'],
  );
});

test('readNamedExports collects every declarator of a multi-declarator export', () => {
  // Documented in the helper's contract; the direct-declaration test above
  // only exercises a single declarator, so the second name went unpinned.
  assert.deepEqual(readNamedExports('export const a = 1, b = 2;'), ['a', 'b']);
});
