import { test } from 'vitest';
import assert from 'node:assert/strict';
import { isReplayInfrastructureFailure } from '../session-test-infrastructure.ts';
import type { DaemonResponse } from '../../types.ts';
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

test('isReplayInfrastructureFailure keeps message fallback for legacy errors', () => {
  const response: DaemonResponse = {
    ok: false,
    error: {
      code: 'COMMAND_FAILED',
      message: 'Runner did not accept connection',
    },
  };

  assert.equal(isReplayInfrastructureFailure(response), true);
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
