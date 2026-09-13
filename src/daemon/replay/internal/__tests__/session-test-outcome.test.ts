import { expect, test } from 'vitest';
import { toReplayTestAttemptOutcome } from '../session-test-outcome.ts';
import type { DaemonResponse } from '../../../daemon-request.ts';

test('failed attempt outcome carries warnings from the error details (#2560)', () => {
  const response: DaemonResponse = {
    ok: false,
    error: {
      code: 'REPLAY_DIVERGENCE',
      message: 'Replay failed at step 2 (tapOn Save): target did not resolve',
      details: {
        replayPath: '/flows/login.yaml',
        step: 2,
        warnings: ['Optional Maestro assertVisible skipped at line 1: not found'],
      },
    },
  };

  const outcome = toReplayTestAttemptOutcome(response);

  expect(outcome).toMatchObject({
    status: 'failed',
    warnings: ['Optional Maestro assertVisible skipped at line 1: not found'],
    infrastructure: false,
  });
});

test('failed attempt outcome reads an empty warnings array when absent or non-string', () => {
  const withoutWarnings = toReplayTestAttemptOutcome({
    ok: false,
    error: { code: 'COMMAND_FAILED', message: 'step failed' },
  });
  expect(withoutWarnings.status === 'failed' && withoutWarnings.warnings).toEqual([]);

  const emptyWarnings = toReplayTestAttemptOutcome({
    ok: false,
    error: { code: 'COMMAND_FAILED', message: 'step failed', details: { warnings: [7] } },
  });
  expect(emptyWarnings.status === 'failed' && emptyWarnings.warnings).toEqual([]);
});

test('passed attempt outcome keeps reading warnings from response data', () => {
  const outcome = toReplayTestAttemptOutcome({
    ok: true,
    data: { replayed: 3, warnings: ['capture degraded'], artifactPaths: [] },
  });

  expect(outcome).toMatchObject({
    status: 'passed',
    replayed: 3,
    warnings: ['capture degraded'],
  });
});
