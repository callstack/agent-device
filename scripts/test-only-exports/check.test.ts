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
import { computeTestOnlyExports, main } from './check.ts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const fallowBin = path.join(repoRoot, 'node_modules/.bin/fallow');

type FixtureOptions = {
  annotation: 'none' | 'direct' | 'detached';
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
  const annotation =
    options.annotation === 'none'
      ? []
      : [
          '// test-seam: fixture twin proving the annotation is honored',
          ...(options.annotation === 'detached' ? ['const unrelated = true;'] : []),
        ];
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
      ...annotation,
      'export function clearSessionHints(session: string): string {',
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
  const root = writeFixture({ annotation: 'none' });
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
  const root = writeFixture({ annotation: 'direct' });
  try {
    assert.deepEqual(computeTestOnlyExports({ root, fallowBin }), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a detached test-seam annotation does not suppress the finding', () => {
  const root = writeFixture({ annotation: 'detached' });
  try {
    assert.deepEqual(computeTestOnlyExports({ root, fallowBin }), [
      { path: 'src/session-hints.ts', export: 'clearSessionHints', line: 11 },
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('an unannotated addition fails without modifying the baseline', () => {
  const root = writeFixture({ annotation: 'none' });
  const scripts = path.join(root, 'scripts');
  const baselinePath = path.join(scripts, 'test-only-exports-baseline.json');
  fs.mkdirSync(scripts);
  fs.writeFileSync(baselinePath, '[]\n');
  try {
    assert.equal(main([], { root, fallowBin }), 1);
    assert.equal(fs.readFileSync(baselinePath, 'utf8'), '[]\n');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('baseline update removes a stale entry', () => {
  const root = writeFixture({ annotation: 'direct' });
  const scripts = path.join(root, 'scripts');
  const baselinePath = path.join(scripts, 'test-only-exports-baseline.json');
  fs.mkdirSync(scripts);
  fs.writeFileSync(
    baselinePath,
    `${JSON.stringify(
      [{ path: 'src/session-hints.ts', export: 'clearSessionHints', line: 9 }],
      null,
      2,
    )}\n`,
  );
  try {
    assert.equal(main(['--update-baseline'], { root, fallowBin }), 0);
    assert.equal(fs.readFileSync(baselinePath, 'utf8'), '[]\n');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
