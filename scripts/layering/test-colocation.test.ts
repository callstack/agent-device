// R84 test-colocation: which tests count as sitting beside a module they are named for, and the
// merge-base ratchet over those that do not.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import {
  checkTestColocation,
  measureUnmatchedTests,
  TEST_COLOCATION_RULE,
  testColocationSummary,
} from './test-colocation.ts';

function unmatched(...files: string[]) {
  return measureUnmatchedTests(files);
}

test('a test named for the module beside it, or for it plus an aspect, is matched', () => {
  assert.deepEqual(
    unmatched(
      'packages/p/src/store.ts',
      'packages/p/src/store.test.ts',
      'packages/p/src/store-recovery.test.ts',
      'src/commands/open.ts',
      'src/commands/open-flags.test.ts',
    ),
    [],
  );
});

test('a test named for no module in its directory is unmatched', () => {
  assert.deepEqual(
    unmatched(
      'packages/p/src/store.ts',
      'packages/p/src/other.test.ts',
      'packages/p/src/store2.test.ts',
      'packages/p/src/sto.test.ts',
    ),
    ['packages/p/src/other.test.ts', 'packages/p/src/sto.test.ts', 'packages/p/src/store2.test.ts'],
  );
});

test('a declaration module is named for its stem: foo.d.ts matches foo.test.ts', () => {
  assert.deepEqual(unmatched('src/foo.d.ts', 'src/foo.test.ts', 'src/foo-shape.test.ts'), []);
  assert.deepEqual(unmatched('src/foo.d.ts', 'src/foo.d.test.ts'), ['src/foo.d.test.ts']);
});

test('the aspect suffix is dash-separated: a dotted or glued name does not match', () => {
  assert.deepEqual(
    unmatched(
      'packages/p/src/store.ts',
      'packages/p/src/store.recovery.test.ts',
      'packages/p/src/storerecovery.test.ts',
    ),
    ['packages/p/src/store.recovery.test.ts', 'packages/p/src/storerecovery.test.ts'],
  );
});

test('a test in __tests__ is judged against the modules of its parent directory', () => {
  assert.deepEqual(
    unmatched(
      'packages/p/src/handlers/lease.ts',
      'packages/p/src/handlers/__tests__/lease.test.ts',
      'packages/p/src/handlers/__tests__/lease-expiry.test.ts',
      'src/session.ts',
      'src/__tests__/session.test.ts',
    ),
    [],
  );
  assert.deepEqual(
    unmatched(
      'packages/p/src/handlers/lease.ts',
      'packages/p/src/handlers/__tests__/session.test.ts',
      'packages/p/src/handlers/__tests__/support/lease.test.ts',
    ),
    [
      'packages/p/src/handlers/__tests__/session.test.ts',
      'packages/p/src/handlers/__tests__/support/lease.test.ts',
    ],
  );
});

test('modules inside __tests__ do not make a test matched', () => {
  assert.deepEqual(
    unmatched('packages/p/src/__tests__/helper.ts', 'packages/p/src/__tests__/helper.test.ts'),
    ['packages/p/src/__tests__/helper.test.ts'],
  );
});

test('index is an ordinary module: a cross-module package test is index-<aspect>.test.ts', () => {
  assert.deepEqual(
    unmatched(
      'packages/p/src/index.ts',
      'packages/p/src/index-surface.test.ts',
      'packages/p/src/index-conformance.test.ts',
    ),
    [],
  );
  assert.deepEqual(unmatched('packages/p/src/index.ts', 'packages/p/src/surface.test.ts'), [
    'packages/p/src/surface.test.ts',
  ]);
  // Without an index.ts beside it there is nothing for the name to point at.
  assert.deepEqual(unmatched('packages/p/src/index-surface.test.ts'), [
    'packages/p/src/index-surface.test.ts',
  ]);
});

test('fixtures never count as the module a test is named for, and test-kit is not measured', () => {
  assert.deepEqual(unmatched('packages/p/src/store.fixtures.ts', 'packages/p/src/store.test.ts'), [
    'packages/p/src/store.test.ts',
  ]);
  assert.deepEqual(unmatched('packages/test-kit/src/other.test.ts'), []);
});

test('test/, scripts/ and package test trees are exempt: the rule reads src trees only', () => {
  assert.deepEqual(
    unmatched(
      'test/integration/smoke.test.ts',
      'test/repo-guards/swift-sources.test.ts',
      'scripts/layering/check-wiring.test.ts',
      'packages/p/test/conformance.test.ts',
      'packages/p/package.json',
    ),
    [],
  );
});

test('a daemon-composition style suite under src/__tests__ is unmatched', () => {
  assert.deepEqual(
    unmatched('src/__tests__/daemon-composition/handlers/claims.test.ts', 'src/session.ts'),
    ['src/__tests__/daemon-composition/handlers/claims.test.ts'],
  );
});

test('growth against the merge-base fails; moving a test into place or an unchanged set passes', () => {
  const base = ['src/__tests__/a.test.ts', 'src/__tests__/b.test.ts'];
  const violations = checkTestColocation(
    ['src/__tests__/b.test.ts', 'src/__tests__/c.test.ts'],
    base,
  );
  assert.equal(violations.length, 1);
  assert.equal(violations[0]!.rule, TEST_COLOCATION_RULE);
  assert.equal(violations[0]!.file, 'src/__tests__/c.test.ts');
  assert.match(violations[0]!.message, /index-<aspect>\.test\.ts/);
  assert.match(violations[0]!.message, /test\/repo-guards\//);
  assert.deepEqual(checkTestColocation([], base), []);
  assert.deepEqual(checkTestColocation(base, base), []);
});

test('the remedy locations R84 names are collected by a vitest project', () => {
  // A test moved to test/repo-guards/ must run somewhere: no gate fails on a test no project collects.
  const config = fs.readFileSync(
    path.resolve(import.meta.dirname, '../../vitest.config.ts'),
    'utf8',
  );
  assert.match(config, /'test\/repo-guards\/\*\.test\.ts'/);
});

test('the summary reports the remaining count against the merge-base', () => {
  assert.match(
    testColocationSummary(['a'], ['a', 'b']),
    /1 unmatched test\(s\) remain against 2 at the merge-base \(R84\)/,
  );
});
