import { test } from 'vitest';
import assert from 'node:assert/strict';
import { isReplayInfrastructureFailure } from '../session-test-infrastructure.ts';
import { buildReplayDivergenceFailureResponseFromDescriptor } from '../session-replay-runtime-failure-response.ts';
import type { DaemonResponse } from '@agent-device/kernel/contracts';
import type { ReplaySuiteTestResult } from '@agent-device/contracts/replay';

test('isReplayInfrastructureFailure accepts shared boot diagnostic reasons', () => {
  const response: DaemonResponse = {
    ok: false,
    error: {
      code: 'COMMAND_FAILED',
      message: 'Runner startup failed',
      details: { reason: 'IOS_RUNNER_CONNECT_TIMEOUT' },
    },
  };

  assert.equal(isReplayInfrastructureFailure(response), true);
});

test('isReplayInfrastructureFailure ignores infrastructure-shaped message text without a typed reason', () => {
  for (const message of [
    'Runner did not accept connection',
    'Replay failed at step 2 (wait text "Device offline"): timeout',
    'Replay failed at step 3 (click label="Device is offline"): ELEMENT_NOT_FOUND',
    'adb: device unauthorized.',
  ]) {
    const response: DaemonResponse = {
      ok: false,
      error: { code: 'REPLAY_DIVERGENCE', message, details: { step: 2 } },
    };
    assert.equal(isReplayInfrastructureFailure(response), false, message);
  }
});

test('isReplayInfrastructureFailure accepts a replayed step that failed on a typed adb refusal', () => {
  for (const adbFailure of ['device_offline', 'device_unauthorized'] as const) {
    const response = buildReplayDivergenceFailureResponseFromDescriptor({
      error: {
        code: 'COMMAND_FAILED',
        message: 'adb refused the command',
        details: { adbFailure, retriable: true },
      },
      actionLabel: 'press Continue',
      action: 'press',
      positionals: ['Continue'],
      step: 2,
      replayPath: '/tmp/flows/login.ad',
      artifactPaths: [],
      divergence: {},
      scrubVars: [],
    });
    assert.equal(isReplayInfrastructureFailure(response), true, adbFailure);
  }
  const notFound: DaemonResponse = {
    ok: false,
    error: {
      code: 'COMMAND_FAILED',
      message: 'adb: device not found',
      details: { adbFailure: 'device_not_found' },
    },
  };
  assert.equal(isReplayInfrastructureFailure(notFound), false);
});

test('isReplayInfrastructureFailure accepts typed runner connect failures through a replay divergence', () => {
  for (const details of [
    { reason: 'runner_process_exited' },
    { reason: 'BOOT_COMMAND_FAILED', runnerConnectFailureReason: 'xcodebuild_exited_early' },
    { reason: 'UNKNOWN', runnerConnectFailureReason: 'runner_connect_refused' },
  ]) {
    const response = buildReplayDivergenceFailureResponseFromDescriptor({
      error: { code: 'COMMAND_FAILED', message: 'runner failed', details },
      actionLabel: 'press Continue',
      action: 'press',
      positionals: ['Continue'],
      step: 2,
      replayPath: '/tmp/flows/login.ad',
      artifactPaths: [],
      divergence: {},
      scrubVars: [],
    });
    assert.equal(isReplayInfrastructureFailure(response), true, JSON.stringify(details));
  }
});

test('isReplayInfrastructureFailure accepts replay timeout cleanup races', () => {
  const response: DaemonResponse = {
    ok: false,
    error: {
      code: 'COMMAND_FAILED',
      message: 'TIMEOUT after 120000ms',
      details: { reason: 'timeout_cleanup_pending', timeoutCleanupPending: true },
    },
  };

  assert.equal(isReplayInfrastructureFailure(response), true);
});

test('isReplayInfrastructureFailure accepts the owning runtime verdict', () => {
  const result: ReplaySuiteTestResult = {
    file: 'cleanup.ad',
    session: 'default:test:cleanup',
    status: 'failed',
    durationMs: 1,
    attempts: 1,
    error: {
      code: 'COMMAND_FAILED',
      message: 'Replay test cleanup failed',
    },
    infrastructure: true,
  };

  assert.equal(isReplayInfrastructureFailure(result), true);
});

test('isReplayInfrastructureFailure accepts a typed foreign runner owner', () => {
  const response: DaemonResponse = {
    ok: false,
    error: {
      code: 'COMMAND_FAILED',
      message: 'Runner is busy',
      details: { reason: 'IOS_RUNNER_OWNED_BY_OTHER_DAEMON' },
    },
  };

  assert.equal(isReplayInfrastructureFailure(response), true);
});

test('isReplayInfrastructureFailure accepts typed runner recycle exhaustion', () => {
  const response: DaemonResponse = {
    ok: false,
    error: {
      code: 'COMMAND_FAILED',
      message:
        'iOS runner was already restarted during this request and "snapshot" still failed, so agent-device stopped instead of paying for another runner boot.',
      details: { recovery: 'runner_recycle_budget_exhausted' },
    },
  };

  assert.equal(isReplayInfrastructureFailure(response), true);
});

test('isReplayInfrastructureFailure does not infer a device claim from message text', () => {
  const response: DaemonResponse = {
    ok: false,
    error: {
      code: 'REPLAY_DIVERGENCE',
      message: 'macOS device host-macos-local is owned by another session.',
    },
  };

  assert.equal(isReplayInfrastructureFailure(response), false);
});

test('isReplayInfrastructureFailure keeps untyped DEVICE_IN_USE failures behavioral', () => {
  const response: DaemonResponse = {
    ok: false,
    error: {
      code: 'DEVICE_IN_USE',
      message: 'The requested device is busy with another session.',
      retriable: true,
    },
  };

  assert.equal(isReplayInfrastructureFailure(response), false);
});

test('isReplayInfrastructureFailure rejects normal replay failures', () => {
  const response: DaemonResponse = {
    ok: false,
    error: {
      code: 'ELEMENT_NOT_FOUND',
      message: 'Maestro selector did not match: text="Settings"',
      details: { reason: 'selector_not_found' },
    },
  };

  assert.equal(isReplayInfrastructureFailure(response), false);
});
