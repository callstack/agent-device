import { AppError, normalizeError } from '@agent-device/kernel/errors';
import { expect, test, vi } from 'vitest';
import type {
  AndroidApplicationTools,
  AppleApplicationTools,
} from '@agent-device/contracts/application-lifecycle-runtime';
import { createApplicationResourceLifecycle } from './platform-runtime-application-resources.ts';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { resolveDeviceClaimRoot } from '@agent-device/host-kit/file';
import { canonicalLocalDeviceKey } from '@agent-device/daemon-contracts/device-claims';
import { mkdtempForTestSync } from '@agent-device/test-kit';
import { resolveDaemonPaths } from '@agent-device/daemon-contracts/daemon-resolution';
import { startDaemonRuntime } from '@agent-device/daemon';
import {
  recordingDaemonDeps,
  recordingDaemonHost,
} from './__tests__/test-utils/recording-daemon.ts';

function lifecycle(overrides: {
  hasTestImeRecoveryEvidence: AndroidApplicationTools['hasTestImeRecoveryEvidence'];
  recoverTestImeStartup: AndroidApplicationTools['recoverTestImeStartup'];
  detachRunnerSessionsForShutdown?: AppleApplicationTools['detachRunnerSessionsForShutdown'];
  finalizeRunnerSessionsForShutdown?: AppleApplicationTools['finalizeRunnerSessionsForShutdown'];
  closeValidatorPreparation?: () => Promise<void>;
}) {
  return createApplicationResourceLifecycle({
    android: {
      hasTestImeRecoveryEvidence: overrides.hasTestImeRecoveryEvidence,
      recoverTestImeStartup: overrides.recoverTestImeStartup,
    } as unknown as AndroidApplicationTools,
    apple: {
      detachRunnerSessionsForShutdown:
        overrides.detachRunnerSessionsForShutdown ?? (async () => {}),
      finalizeRunnerSessionsForShutdown:
        overrides.finalizeRunnerSessionsForShutdown ?? (async () => {}),
    } as unknown as AppleApplicationTools,
    recording: {
      finalize: { prepare: async () => {} },
      closeValidatorPreparation: overrides.closeValidatorPreparation ?? (async () => {}),
    },
  });
}

test('startup recovery reaches Android mechanics only after validated marker evidence', async () => {
  const hasTestImeRecoveryEvidence = vi.fn(async () => false);
  const recoverTestImeStartup = vi.fn(async () => {});
  const resources = lifecycle({ hasTestImeRecoveryEvidence, recoverTestImeStartup });
  const stateDir = '/tmp/platform-runtime-marker-evidence';

  await resources.recoverStartupResources({ stateDir });

  expect(hasTestImeRecoveryEvidence).toHaveBeenCalledExactlyOnceWith(stateDir);
  expect(recoverTestImeStartup).not.toHaveBeenCalled();

  hasTestImeRecoveryEvidence.mockResolvedValueOnce(true);
  await resources.recoverStartupResources({ stateDir });

  expect(recoverTestImeStartup).toHaveBeenCalledExactlyOnceWith({ stateDir });
});

test('daemon shutdown phases delegate to the Apple runner owner', async () => {
  const detachRunnerSessionsForShutdown = vi.fn(async () => ['ios-sim']);
  const finalizeRunnerSessionsForShutdown = vi.fn(async () => ['ios-sim']);
  const closeValidatorPreparation = vi.fn(async () => {});
  const resources = lifecycle({
    hasTestImeRecoveryEvidence: async () => false,
    recoverTestImeStartup: async () => {},
    detachRunnerSessionsForShutdown,
    finalizeRunnerSessionsForShutdown,
    closeValidatorPreparation,
  });

  await resources.detachForDaemonShutdown();
  await resources.finalizeDaemonShutdown();

  expect(detachRunnerSessionsForShutdown).toHaveBeenCalledOnce();
  expect(finalizeRunnerSessionsForShutdown).toHaveBeenCalledOnce();
  expect(closeValidatorPreparation).toHaveBeenCalledOnce();
});

test('a validator compile is closed before the device sweep that may wait on a recorder', async () => {
  const order: string[] = [];
  const resources = lifecycle({
    hasTestImeRecoveryEvidence: async () => false,
    recoverTestImeStartup: async () => {},
    finalizeRunnerSessionsForShutdown: async () => {
      order.push('runners');
      return [];
    },
    closeValidatorPreparation: async () => {
      order.push('validator');
    },
  });

  await resources.finalizeDaemonShutdown();

  expect(order).toEqual(['validator', 'runners']);
});

test('a failing runner sweep still closes the validator compile and reports its own failure', async () => {
  const sweepFailure = new Error('runner finalization failed');
  const closeValidatorPreparation = vi.fn(async () => {});
  const resources = lifecycle({
    hasTestImeRecoveryEvidence: async () => false,
    recoverTestImeStartup: async () => {},
    finalizeRunnerSessionsForShutdown: async () => {
      throw sweepFailure;
    },
    closeValidatorPreparation,
  });

  await expect(resources.finalizeDaemonShutdown()).rejects.toMatchObject({
    details: { shutdownFailures: [{ message: sweepFailure.message }] },
  });
  expect(closeValidatorPreparation).toHaveBeenCalledOnce();
});

test('a failed validator close is reported when the runner sweep succeeded', async () => {
  const closeFailure = new Error('swiftc cleanup failed');
  const resources = lifecycle({
    hasTestImeRecoveryEvidence: async () => false,
    recoverTestImeStartup: async () => {},
    finalizeRunnerSessionsForShutdown: async () => ['ios-sim'],
    closeValidatorPreparation: async () => {
      throw closeFailure;
    },
  });

  await expect(resources.finalizeDaemonShutdown()).rejects.toMatchObject({
    details: { shutdownFailures: [{ message: closeFailure.message }] },
  });
});

test('shutdown retains both runner and validator cleanup failures', async () => {
  const runner = new Error('runner failure');
  const validator = new Error('validator failure');
  const resources = lifecycle({
    hasTestImeRecoveryEvidence: async () => false,
    recoverTestImeStartup: async () => {},
    finalizeRunnerSessionsForShutdown: async () => {
      throw runner;
    },
    closeValidatorPreparation: async () => {
      throw validator;
    },
  });
  const failure = await resources.finalizeDaemonShutdown().catch((error: unknown) => error);
  expect(normalizeError(failure).details).toMatchObject({
    reason: 'application_resource_shutdown_failed',
    shutdownFailures: [{ message: runner.message }, { message: validator.message }],
  });
});

test('normalized shutdown preserves sanitized runner and validator cleanup evidence', async () => {
  const compile = new AppError('COMMAND_FAILED', 'compile failed token=private', {
    reason: 'compile_failed',
  });
  const temp = new AppError(
    'COMMAND_FAILED',
    'temp failed',
    { reason: 'swift_cache_temp_removal_failed' },
    new Error('password=hidden'),
  );
  const lock = new AppError('COMMAND_FAILED', 'lock failed', {
    reason: 'swift_cache_lock_release_failed',
  });
  const validator = new AppError(
    'COMMAND_FAILED',
    'Swift cache cleanup failed',
    { reason: 'swift_cache_cleanup_failed' },
    new AggregateError([compile, temp, lock]),
  );
  const runner = new AppError('COMMAND_FAILED', 'runner failed', {
    reason: 'runner_failed',
    token: 'private',
  });
  const resources = lifecycle({
    hasTestImeRecoveryEvidence: async () => false,
    recoverTestImeStartup: async () => {},
    finalizeRunnerSessionsForShutdown: async () => {
      throw runner;
    },
    closeValidatorPreparation: async () => {
      throw validator;
    },
  });
  const ownerFailure = await resources.finalizeDaemonShutdown().catch((error: unknown) => error);
  const normalized = normalizeError(ownerFailure);
  expect(normalized.details).toMatchObject({
    reason: 'application_resource_shutdown_failed',
    shutdownFailures: [
      { details: { reason: 'runner_failed', token: '[REDACTED]' } },
      {
        details: {
          reason: 'swift_cache_cleanup_failed',
          shutdownFailures: [
            { message: 'compile failed token=[REDACTED]', details: { reason: 'compile_failed' } },
            {
              details: { reason: 'swift_cache_temp_removal_failed' },
              cause: { message: 'password=[REDACTED]' },
            },
            { details: { reason: 'swift_cache_lock_release_failed' } },
          ],
        },
      },
    ],
  });
  expect(JSON.stringify(normalized)).not.toContain('private');
  expect(JSON.stringify(normalized)).not.toContain('hidden');
});

test('normalized validator-only shutdown retains cleanup evidence from both attempts', async () => {
  const attempt = (name: string) =>
    new AppError(
      'COMMAND_FAILED',
      'Swift cache cleanup failed',
      { reason: 'swift_cache_cleanup_failed' },
      new AggregateError([
        new AppError('COMMAND_FAILED', `${name} compile`, { reason: 'compile_failed' }),
        new AppError('COMMAND_FAILED', `${name} removal`, {
          reason: 'swift_cache_temp_removal_failed',
        }),
      ]),
    );
  const resources = lifecycle({
    hasTestImeRecoveryEvidence: async () => false,
    recoverTestImeStartup: async () => {},
    closeValidatorPreparation: async () => {
      throw new AggregateError([attempt('first'), attempt('second')], 'attempts failed');
    },
  });
  const error = await resources.finalizeDaemonShutdown().catch((error: unknown) => error);
  const result = normalizeError(error);
  expect(result.details).toMatchObject({
    shutdownFailures: [
      {
        details: {
          shutdownFailures: [
            {
              details: {
                reason: 'swift_cache_cleanup_failed',
                shutdownFailures: [{ message: 'first compile' }, { message: 'first removal' }],
              },
            },
            {
              details: {
                reason: 'swift_cache_cleanup_failed',
                shutdownFailures: [{ message: 'second compile' }, { message: 'second removal' }],
              },
            },
          ],
        },
      },
    ],
  });
});

test('daemon close records sanitized application resource cleanup failures', async () => {
  const stateDir = mkdtempForTestSync('application-resource-close-');
  const resources = lifecycle({
    hasTestImeRecoveryEvidence: async () => false,
    recoverTestImeStartup: async () => {},
    finalizeRunnerSessionsForShutdown: async () => {
      throw new AppError('COMMAND_FAILED', 'runner failed', { reason: 'runner_failed' });
    },
    closeValidatorPreparation: async () => {
      throw new AppError(
        'COMMAND_FAILED',
        'validator failed',
        { reason: 'swift_cache_cleanup_failed' },
        new AggregateError([
          new AppError('COMMAND_FAILED', 'temp failed', {
            reason: 'swift_cache_temp_removal_failed',
            token: 'private',
          }),
          new AppError('COMMAND_FAILED', 'lock failed', {
            reason: 'swift_cache_lock_release_failed',
          }),
        ]),
      );
    },
  });
  const runtime = await startDaemonRuntime({
    host: recordingDaemonHost({
      env: {
        AGENT_DEVICE_STATE_DIR: stateDir,
        AGENT_DEVICE_DAEMON_IDLE_TIMEOUT_MS: '0',
        AGENT_DEVICE_DAEMON_SERVER_MODE: 'http',
      },
    }),
    stderr: { write: () => {} },
    stdout: { write: () => {} },
    composeDeps: recordingDaemonDeps((gateway) => ({
      ...gateway,
      applicationLifecycle: resources,
    })),
  });
  await expect(runtime.close()).rejects.toMatchObject({
    details: { reason: 'application_resource_shutdown_failed' },
  });
  const log = fs.readFileSync(resolveDaemonPaths(stateDir).logPath, 'utf8');
  expect(log).toContain('daemon_shutdown_application_resources_failed');
  expect(log).toContain('runner_failed');
  expect(log).toContain('swift_cache_cleanup_failed');
  expect(log).toContain('swift_cache_temp_removal_failed');
  expect(log).toContain('swift_cache_lock_release_failed');
  expect(log).not.toContain('private');
});

test('a composed daemon uses its isolated claim root and leaves a foreign dead claim untouched', async () => {
  const sentinelRoot = mkdtempForTestSync('recording-foreign-claims-');
  const foreignState = mkdtempForTestSync('recording-foreign-state-');
  const stateDir = mkdtempForTestSync('recording-isolated-state-');
  const child = spawn(process.execPath, ['-e', '']);
  const pid = child.pid;
  if (!pid) throw new Error('test child did not start');
  await once(child, 'exit');
  const key = canonicalLocalDeviceKey({
    family: 'android',
    id: 'foreign-device',
    kind: 'emulator',
  });
  const claimPath = path.join(
    sentinelRoot,
    `${crypto.createHash('sha256').update(key).digest('hex')}.json`,
  );
  const claim = JSON.stringify({
    schemaVersion: 3,
    deviceKey: key,
    device: { family: 'android', id: 'foreign-device', kind: 'emulator', name: 'foreign' },
    session: 'foreign',
    workspace: foreignState,
    stateDir: foreignState,
    ownerPid: pid,
    ownerStartTime: null,
    ownerToken: 'foreign-token',
    createdAtMs: 1,
    updatedAtMs: 1,
    claimOwnerKind: 'open-session',
  });
  fs.writeFileSync(claimPath, claim);
  const oldClaimRoot = process.env.AGENT_DEVICE_CLAIMS_DIR;
  process.env.AGENT_DEVICE_CLAIMS_DIR = sentinelRoot;
  let runtime: Awaited<ReturnType<typeof startDaemonRuntime>> | undefined;
  try {
    const host = recordingDaemonHost({
      env: {
        AGENT_DEVICE_STATE_DIR: stateDir,
        AGENT_DEVICE_DAEMON_IDLE_TIMEOUT_MS: '0',
        AGENT_DEVICE_DAEMON_SERVER_MODE: 'http',
      },
    });
    expect(host.env.AGENT_DEVICE_CLAIMS_DIR).toBeDefined();
    expect(resolveDeviceClaimRoot(host.env)).toBe(host.env.AGENT_DEVICE_CLAIMS_DIR);
    expect(host.env.AGENT_DEVICE_CLAIMS_DIR).not.toBe(sentinelRoot);
    runtime = await startDaemonRuntime({
      host,
      stdout: { write: () => {} },
      stderr: { write: () => {} },
      composeDeps: recordingDaemonDeps((gateway) => gateway),
    });
    expect(fs.readFileSync(claimPath, 'utf8')).toBe(claim);
  } finally {
    if (runtime) await runtime.close();
    if (oldClaimRoot === undefined) delete process.env.AGENT_DEVICE_CLAIMS_DIR;
    else process.env.AGENT_DEVICE_CLAIMS_DIR = oldClaimRoot;
  }
});
