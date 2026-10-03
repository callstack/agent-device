import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';
import { runReplayTestCase } from '../session-test-attempt.ts';
import type { ReplayTestRunEntry } from '../session-test-discovery.ts';
import type { ReplayTestAttemptOutcome } from '../session-test-types.ts';
import type { ReplaySuiteTestFailed } from '@agent-device/contracts/replay';
import { mkdtempForTestSync } from '../../tmp-dir.fixtures.ts';

const FAILED_WITH_WARNINGS: ReplayTestAttemptOutcome = {
  status: 'failed',
  error: {
    code: 'REPLAY_DIVERGENCE',
    message: 'Replay failed at step 2 (tapOn "Save"): target did not resolve',
  },
  artifactPaths: [],
  warnings: ['Optional Maestro assertVisible skipped at line 3: sheet owns focus'],
  infrastructure: false,
};

const FAILED_WITHOUT_WARNINGS: ReplayTestAttemptOutcome = {
  status: 'failed',
  error: { code: 'COMMAND_FAILED', message: 'tap failed' },
  artifactPaths: [],
  warnings: [],
  infrastructure: false,
};

function makeEntry(): ReplayTestRunEntry {
  const root = mkdtempForTestSync('agent-device-test-attempt-');
  const filePath = path.join(root, '01-flow.ad');
  fs.writeFileSync(filePath, 'context platform=ios\nopen "Demo"\n');
  return {
    kind: 'run',
    path: filePath,
    title: 'flow',
    manifest: { device: { platform: { kind: 'declared', value: 'ios' } } },
  };
}

async function runFailedCase(outcome: ReplayTestAttemptOutcome): Promise<ReplaySuiteTestFailed> {
  const report = await runReplayTestCase({
    entry: makeEntry(),
    sessionName: 'default',
    suiteInvocationId: 'suite-attempt',
    caseIndex: 0,
    retries: 0,
    suiteArtifactsDir: mkdtempForTestSync('agent-device-test-attempt-suite-'),
    suiteIndex: 1,
    suiteTotal: 1,
    runReplay: async () => outcome,
    cleanupSession: async () => {},
    emitProgress: () => {},
    isCanceled: () => false,
    emitDiagnostic: () => {},
    bindAttemptCancellation: () => ({ cancel: () => {}, release: () => {} }),
  });
  if (report.result.status !== 'failed') throw new Error('expected a failed test result');
  return report.result;
}

test('a failed test result carries the warnings accumulated before the failure (#2560)', async () => {
  const result = await runFailedCase(FAILED_WITH_WARNINGS);
  expect(result.warnings).toEqual([
    'Optional Maestro assertVisible skipped at line 3: sheet owns focus',
  ]);
});

test('a failed test result omits warnings when the attempt had none', async () => {
  const result = await runFailedCase(FAILED_WITHOUT_WARNINGS);
  expect('warnings' in result).toBe(false);
});
