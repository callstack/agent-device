import assert from 'node:assert/strict';
import { test } from 'node:test';
import { countOwnFileBindingReferences } from './own-file-binding.ts';

test('ignores comments, strings, property names, types, and shadowed bindings', () => {
  const source = [
    '/** clearHints is documented by name. */',
    'export function clearHints(): void {}',
    "const note = 'clearHints is unused in prod';",
    'const object = { clearHints: 1 };',
    'object.clearHints;',
    'type Shape = { clearHints: typeof clearHints };',
    'function shadowed(clearHints: () => void): void { clearHints(); }',
  ].join('\n');
  assert.equal(countOwnFileBindingReferences('t.ts', source, 'clearHints'), 0);
});

test('counts calls, shorthand properties, computed keys, and template substitutions', () => {
  const scenarios = [
    'clearHints();',
    'const object = { clearHints };',
    'const value = object[clearHints];',
    'const template = `${clearHints()}`;',
  ];
  for (const usage of scenarios) {
    const source = ['export function clearHints(): void {}', usage].join('\n');
    assert.equal(countOwnFileBindingReferences('t.ts', source, 'clearHints'), 1, usage);
  }
});

test('does not mistake self-reference for a production call site', () => {
  const source = [
    'export function clearHints(retry: boolean): void {',
    '  if (retry) clearHints(false);',
    '}',
  ].join('\n');
  assert.equal(countOwnFileBindingReferences('t.ts', source, 'clearHints'), 0);
});

test('tracks the local binding behind an aliased export', () => {
  const source = [
    'function localHints(): void {}',
    'localHints();',
    'export { localHints as clearHints };',
  ].join('\n');
  assert.equal(countOwnFileBindingReferences('t.ts', source, 'clearHints'), 1);
});

test('a barrel re-export has no own-file binding reference', () => {
  const source = "export { clearHints } from './hints.ts';";
  assert.equal(countOwnFileBindingReferences('t.ts', source, 'clearHints'), 0);
});

test('returns undefined for an unparseable file', () => {
  assert.equal(
    countOwnFileBindingReferences('t.ts', 'export function {{{', 'clearHints'),
    undefined,
  );
});
