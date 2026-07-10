// Re-runnable acceptance test for the test-only-exports ratchet, mirroring
// scripts/layering/model.test.ts. The fixture scenarios reproduce the shape
// of PR #1199's clearMetroSessionHints (exported + unit-tested + zero
// production call sites) and the reviewer-constructed false negatives from
// PR #1202's review (JSDoc/string mentions of the export's own name).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeTestOnlyExports, countIdentifierOccurrences } from './check.ts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const fallowBin = path.join(repoRoot, 'node_modules/.bin/fallow');

test('JSDoc and string mentions of the export name are not call sites', () => {
  const source = [
    '/**',
    ' * clearHints is documented here mentioning clearHints by name.',
    ' */',
    'export function clearHints(): void {}',
    "const note = 'clearHints is unused in prod';",
    'const tpl = `template text clearHints`;',
  ].join('\n');
  assert.equal(countIdentifierOccurrences('t.ts', source, 'clearHints'), 1);
});

test('a template substitution or same-file call is a real occurrence', () => {
  const called = ['export function clearHints(): void {}', 'clearHints();'].join('\n');
  assert.equal(countIdentifierOccurrences('t.ts', called, 'clearHints'), 2);
  const substituted = [
    'export function clearHints(): string { return ""; }',
    'const tpl = `${clearHints()}`;',
  ].join('\n');
  assert.equal(countIdentifierOccurrences('t.ts', substituted, 'clearHints'), 2);
});

test('a // inside a string does not hide a real usage after it', () => {
  // The pre-review regex stripped everything after a `//` even inside a
  // string literal, which could under-count real same-line usages.
  const source = [
    'export function clearHints(): void {}',
    "const url = 'https://example.com'; clearHints();",
  ].join('\n');
  assert.equal(countIdentifierOccurrences('t.ts', source, 'clearHints'), 2);
});

test('a barrel re-export counts its source token once', () => {
  const source = "export { clearHints } from './hints.ts';";
  assert.equal(countIdentifierOccurrences('t.ts', source, 'clearHints'), 1);
});

test('an unparseable file reports undefined instead of a count', () => {
  assert.equal(countIdentifierOccurrences('t.ts', 'export function {{{', 'clearHints'), undefined);
});

type FixtureOptions = {
  annotated: boolean;
};

function writeFixture(options: FixtureOptions): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'test-only-exports-fixture-'));
  fs.mkdirSync(path.join(root, 'src'));
  // an empty node_modules keeps fallow from warning about a missing install
  fs.mkdirSync(path.join(root, 'node_modules'));
  fs.writeFileSync(
    path.join(root, 'package.json'),
    `${JSON.stringify(
      { name: 'test-only-exports-fixture', private: true, type: 'module', main: 'src/index.ts' },
      null,
      2,
    )}\n`,
  );
  fs.writeFileSync(
    path.join(root, 'src/index.ts'),
    "export { persistSessionHints } from './session-hints.ts';\n",
  );
  const annotation = options.annotated
    ? '// test-seam: fixture twin proving the annotation is honored\n'
    : '';
  fs.writeFileSync(
    path.join(root, 'src/session-hints.ts'),
    [
      'export function persistSessionHints(session: string): string {',
      '  return `persisted:${session}`;',
      '}',
      '',
      '/**',
      ' * clearSessionHints removes the hint file; this JSDoc mentions',
      ' * clearSessionHints by name, like ordinary documentation does.',
      ' */',
      `${annotation}export function clearSessionHints(session: string): string {`,
      '  return `cleared:${session}`;',
      '}',
      '',
    ].join('\n'),
  );
  fs.writeFileSync(
    path.join(root, 'src/session-hints.test.ts'),
    [
      "import { clearSessionHints } from './session-hints.ts';",
      '',
      "if (clearSessionHints('s') !== 'cleared:s') throw new Error('fixture self-check');",
      '',
    ].join('\n'),
  );
  return root;
}

test('flags an exported-and-tested function with zero production call sites', () => {
  const root = writeFixture({ annotated: false });
  try {
    const findings = computeTestOnlyExports({ root, fallowBin });
    assert.deepEqual(findings, [
      { path: 'src/session-hints.ts', export: 'clearSessionHints', line: 9 },
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a test-seam annotation removes the export from the check', () => {
  const root = writeFixture({ annotated: true });
  try {
    assert.deepEqual(computeTestOnlyExports({ root, fallowBin }), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
