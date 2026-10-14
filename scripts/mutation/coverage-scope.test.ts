import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { runCmdSync } from '@agent-device/host-kit/command';
import type { DryRunCompletedEvent } from '@stryker-mutator/api/report';
import { DryRunStatus, TestStatus } from '@stryker-mutator/api/test-runner';
import { mkdtempForTestSync } from '@agent-device/test-kit/tmp-dir';
import {
  assertCoveragePolicy,
  coverageScope,
  scopedTestFiles,
  scopeFingerprint,
} from './coverage-scope.ts';

const root = path.resolve(import.meta.dirname, '../..');
const identity = {
  module: 'snapshot-occlusion' as const,
  epoch: 'invocation-1',
  seed: 123,
  fingerprint: 'inputs-1',
};
const candidates = ['src/a.test.ts', 'src/b.test.ts', 'src/unused.test.ts'];
function event(): DryRunCompletedEvent {
  return {
    result: {
      status: DryRunStatus.Complete,
      tests: candidates.map((file, index) => ({
        id: String(index),
        name: file,
        fileName: path.join(root, file),
        status: TestStatus.Success,
        timeSpentMs: 1,
      })),
      mutantCoverage: {
        static: { declaration: 1 },
        perTest: { '0': { alpha: 1 }, '1': { beta: 1 }, '2': { alpha: 0 } },
      },
    },
    timing: { net: 9, overhead: 1 },
    capabilities: { reloadEnvironment: true },
  };
}

test('coverage union keeps indirect covering tests, omits zero hits and intersects shard candidates', () => {
  const scope = coverageScope(event(), identity, candidates, root, 20);
  assert.deepEqual(scope.covered, ['src/a.test.ts', 'src/b.test.ts']);
  assert.equal(scope.initialRunMs, 10);
  assert.equal(scope.producerMs, 20);
  assert.deepEqual(scopedTestFiles(scope, identity, ['src/b.test.ts', 'src/unused.test.ts']), [
    'src/b.test.ts',
  ]);
  assert.throws(
    () => scopedTestFiles(scope, identity, ['src/unused.test.ts']),
    /selected no tests/,
  );
});

test('missing coverage, failed tests and unattributed covering tests cannot produce an index', () => {
  const missing = event();
  delete missing.result.mutantCoverage;
  assert.throws(() => coverageScope(missing, identity, candidates, root, 20), /per-test/);
  const failed = event();
  failed.result.tests[0] = {
    ...failed.result.tests[0]!,
    status: TestStatus.Failed,
    failureMessage: 'broken',
  };
  assert.throws(() => coverageScope(failed, identity, candidates, root, 20), /failed tests/);
  const unlocated = event();
  delete unlocated.result.tests[0]!.fileName;
  assert.throws(() => coverageScope(unlocated, identity, candidates, root, 20), /cannot attribute/);
  const outside = event();
  outside.result.tests[0]!.fileName = path.join(root, 'src/other.test.ts');
  assert.throws(() => coverageScope(outside, identity, candidates, root, 20), /unexpected test/);
});

test('identity drift, new candidates and a truncated or corrupted index are rejected', () => {
  const scope = coverageScope(event(), identity, candidates, root, 20);
  for (const expected of [
    { ...identity, seed: 124 },
    { ...identity, epoch: 'other' },
    { ...identity, fingerprint: 'changed' },
    { ...identity, module: 'selectors' as const },
  ])
    assert.throws(() => scopedTestFiles(scope, expected, candidates), /does not match/);
  assert.throws(
    () => scopedTestFiles(scope, identity, [...candidates, 'src/new.test.ts']),
    /omits/,
  );
  assert.throws(
    () => scopedTestFiles({ ...scope, covered: ['src/a.test.ts'] }, identity, candidates),
    /checksum/,
  );
  assert.throws(
    () => scopedTestFiles({ ...scope, covered: [] }, identity, candidates),
    /invalid test/,
  );
});

test('pilot policy rejects static audits and incremental reuse', () => {
  assertCoveragePolicy({ coverageAnalysis: 'perTest', ignoreStatic: true });
  for (const config of [
    { coverageAnalysis: 'all', ignoreStatic: true },
    { coverageAnalysis: 'perTest', ignoreStatic: false },
    { coverageAnalysis: 'perTest', ignoreStatic: true, incremental: true },
  ])
    assert.throws(() => assertCoveragePolicy(config), /fresh perTest/);
});

test('fingerprint invalidates source helpers, fixtures, setup, configs, new/deleted tests and environment', () => {
  const fixture = fs.realpathSync(mkdtempForTestSync('mutation-inputs-'));
  runCmdSync('git', ['init', '-q', fixture]);
  fs.symlinkSync(path.join(root, 'node_modules'), path.join(fixture, 'node_modules'));
  fs.writeFileSync(path.join(fixture, '.gitignore'), 'node_modules\n');
  for (const file of [
    'helper.ts',
    'fixture.json',
    'setup.ts',
    'stryker.config.json',
    'pnpm-lock.yaml',
    'test.test.ts',
  ]) {
    const target = path.join(fixture, file);
    fs.writeFileSync(target, 'before');
    const before = scopeFingerprint(fixture);
    fs.writeFileSync(target, 'after');
    assert.notEqual(scopeFingerprint(fixture), before, file);
  }
  const before = scopeFingerprint(fixture);
  fs.writeFileSync(path.join(fixture, 'new.test.ts'), 'new');
  assert.notEqual(scopeFingerprint(fixture), before);
  fs.unlinkSync(path.join(fixture, 'new.test.ts'));
  assert.equal(scopeFingerprint(fixture), before);
  fs.unlinkSync(path.join(fixture, 'test.test.ts'));
  assert.notEqual(scopeFingerprint(fixture), before);
  const withoutEnv = scopeFingerprint(fixture);
  const previous = process.env.MUTATION_SCOPE_INPUT_TEST;
  process.env.MUTATION_SCOPE_INPUT_TEST = previous === 'changed' ? 'changed-again' : 'changed';
  try {
    assert.notEqual(scopeFingerprint(fixture), withoutEnv);
  } finally {
    if (previous === undefined) delete process.env.MUTATION_SCOPE_INPUT_TEST;
    else process.env.MUTATION_SCOPE_INPUT_TEST = previous;
  }
});
