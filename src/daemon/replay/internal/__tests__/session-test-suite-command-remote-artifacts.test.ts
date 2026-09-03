/**
 * #2246: once a remote daemon writes suite artifacts under a temp directory it owns (the client
 * redirects `--artifacts-dir` there — see `daemon-artifacts-test-command.test.ts`), the response
 * this handler builds must point the caller back at the REAL local root the client will download
 * that directory into (`req.meta.clientArtifactPaths.artifactsDir`), and must register the
 * directory as one downloadable artifact so the client's existing artifact transport can pull it.
 * A local daemon never sets that hint, so the response must come back byte-for-byte unchanged.
 *
 * `daemonRoot` here is deliberately two levels (`<tempRoot>/<suiteInvocationId>`), matching what
 * `resolveReplayTestArtifactsDir` actually produces: the redirected temp ROOT the client sent
 * joined with the daemon-generated invocation id. The caller-local mirror of that is
 * `clientRoot/<suiteInvocationId>` — NOT bare `clientRoot`, which is only the root the client
 * resolved from `--artifacts-dir` *before* the suite ran and could not yet know the invocation id.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'vitest';
import type { ReplaySuiteResult } from '@agent-device/contracts/replay';
import type { DaemonRequest } from '../../../types.ts';
import { attachRemoteReplayTestArtifacts } from '../test-command.ts';
import { mkdtempForTestSync } from '../../../../__tests__/test-utils/tmp-dir.ts';

const SUITE_INVOCATION_ID = 'cd5f9c01feec8d70';

function suiteResult(daemonRoot: string): ReplaySuiteResult {
  return {
    total: 2,
    executed: 2,
    passed: 1,
    failed: 1,
    skipped: 1,
    notRun: 0,
    durationMs: 10,
    tests: [
      {
        file: path.join(daemonRoot, '..', '01-open.ad'),
        session: 'default:test:1',
        status: 'passed',
        durationMs: 5,
        attempts: 1,
        artifactsDir: path.join(daemonRoot, 'qa-flows__open.ad', 'attempt-1'),
        replayed: 1,
        healed: 0,
      },
      {
        file: path.join(daemonRoot, '..', '02-checkout.ad'),
        session: 'default:test:2',
        status: 'failed',
        durationMs: 8,
        attempts: 1,
        artifactsDir: path.join(daemonRoot, 'qa-flows__checkout.ad', 'attempt-1'),
        error: { code: 'COMMAND_FAILED', message: 'boom' },
      },
      {
        file: 'skipped.ad',
        status: 'skipped',
        durationMs: 0,
        reason: 'skipped-by-filter',
        message: 'platform mismatch',
      },
    ],
    // The failed test above is intentionally the SAME object reference here, mirroring
    // `summarizeReplayTestResults` (`failures: results.filter(...)`, `tests: results`) — a fix
    // that only rewrites `tests` and forgets `failures` would leave this one unrewritten.
    get failures() {
      return this.tests.filter(
        (t): t is Extract<ReplaySuiteResult['tests'][number], { status: 'failed' }> =>
          t.status === 'failed',
      );
    },
    artifactsDir: daemonRoot,
  };
}

function req(clientArtifactsRoot: string | undefined): DaemonRequest {
  return {
    token: 't',
    session: 'default',
    command: 'test',
    positionals: [],
    meta: clientArtifactsRoot ? { clientArtifactPaths: { artifactsDir: clientArtifactsRoot } } : {},
  };
}

test('rewrites the suite, every test, and every failure to the caller-local root, and registers the directory for download', () => {
  const tempRoot = mkdtempForTestSync('agent-device-remote-test-artifacts-daemon-');
  const daemonRoot = path.join(tempRoot, SUITE_INVOCATION_ID);
  fs.mkdirSync(path.join(daemonRoot, 'qa-flows__open.ad', 'attempt-1'), { recursive: true });
  const clientRoot = '/Users/ci/work/installer-app/remote-device-artifacts/ad-test';
  const clientSuiteRoot = path.join(clientRoot, SUITE_INVOCATION_ID);

  const data = attachRemoteReplayTestArtifacts(suiteResult(daemonRoot), req(clientRoot));

  assert.equal(data.artifactsDir, clientSuiteRoot);
  const tests = data.tests as ReplaySuiteResult['tests'];
  assert.equal(
    (tests[0] as { artifactsDir?: string }).artifactsDir,
    path.join(clientSuiteRoot, 'qa-flows__open.ad', 'attempt-1'),
  );
  assert.equal(
    (tests[1] as { artifactsDir?: string }).artifactsDir,
    path.join(clientSuiteRoot, 'qa-flows__checkout.ad', 'attempt-1'),
  );
  // A skipped test never had an artifactsDir; it must not gain one.
  const skippedTest = tests[2];
  assert.ok(skippedTest);
  assert.equal('artifactsDir' in skippedTest, false);

  const failures = data.failures as ReplaySuiteResult['failures'];
  assert.equal(failures.length, 1);
  assert.equal(
    (failures[0] as { artifactsDir?: string }).artifactsDir,
    path.join(clientSuiteRoot, 'qa-flows__checkout.ad', 'attempt-1'),
  );

  assert.deepEqual(data.artifacts, [
    {
      field: 'artifactsDir',
      artifactType: 'test-artifacts',
      path: daemonRoot,
      // The download destination is the ROOT the client redirected to, not `clientSuiteRoot`:
      // extracting the archive reproduces the invocation-id segment on its own.
      localPath: clientRoot,
      fileName: SUITE_INVOCATION_ID,
    },
  ]);
});

test('a local daemon (no clientArtifactPaths hint) returns the suite result unchanged', () => {
  const tempRoot = mkdtempForTestSync('agent-device-remote-test-artifacts-local-');
  const daemonRoot = path.join(tempRoot, SUITE_INVOCATION_ID);
  fs.mkdirSync(path.join(daemonRoot, 'qa-flows__open.ad', 'attempt-1'), { recursive: true });
  const result = suiteResult(daemonRoot);

  const data = attachRemoteReplayTestArtifacts(result, req(undefined));

  assert.equal(data, result);
});

test('a suite directory that was never created (all sources skipped) still reports the caller-local root, but registers no download', () => {
  const tempRoot = mkdtempForTestSync('agent-device-remote-test-artifacts-empty-');
  const daemonRoot = path.join(tempRoot, SUITE_INVOCATION_ID);
  const clientRoot = '/Users/ci/work/installer-app/remote-device-artifacts/ad-test';
  const result: ReplaySuiteResult = {
    total: 1,
    executed: 0,
    passed: 0,
    failed: 0,
    skipped: 1,
    notRun: 0,
    durationMs: 1,
    failures: [],
    artifactsDir: daemonRoot,
    tests: [
      {
        file: 'skipped.ad',
        status: 'skipped',
        durationMs: 0,
        reason: 'skipped-by-filter',
        message: 'x',
      },
    ],
  };

  const data = attachRemoteReplayTestArtifacts(result, req(clientRoot));

  // Nothing to download, but the reported root is still the caller-local one the suite WOULD
  // have used — not the unreachable daemon-local temp path.
  assert.equal(data.artifactsDir, path.join(clientRoot, SUITE_INVOCATION_ID));
  assert.equal(data.artifacts, undefined);
});
