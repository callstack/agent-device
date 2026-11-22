import fs from 'node:fs';
import path from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { mkdtempForTestSync } from '@agent-device/test-kit';
import { AppError, normalizeError } from '@agent-device/kernel/errors';
import { localRuntimeOwner } from '@agent-device/contracts/platform-runtime';
import {
  flushDiagnosticsToSessionFile,
  withDiagnosticsScope,
} from '@agent-device/host-kit/diagnostics';
import {
  createOwnerScopedDeviceClaimReconciler,
  type OwnerScopedClaimRecovery,
} from './device-claim-owner-recovery.ts';
import { createRecoveryPlatformScope } from './recovery-platform-scope.ts';
import type { DeviceClaim } from './device-claims.ts';
import { resolveDeviceClaimPath } from './device-claim-paths.ts';
import { writeDeviceClaim } from './device-claim-store.ts';
import { settleVerifiedOrphanedClaim } from './device-claim-settlement.ts';

function fixture(
  reconcile: OwnerScopedClaimRecovery['reconcile'],
  failureCount: 1 | 2,
  failureDetails: Record<string, unknown> = {},
  disposeAfter: Promise<void> = Promise.resolve(),
) {
  const stateDir = mkdtempForTestSync('claim-recovery-dispose-');
  const claim: DeviceClaim = {
    schemaVersion: 3,
    claimOwnerKind: 'open-session',
    deviceKey: 'local:android:none:emulator-5554',
    device: { family: 'android', id: 'emulator-5554', name: 'Pixel', kind: 'emulator' },
    session: 'owner-session',
    workspace: '/worktrees/dead',
    stateDir,
    ownerPid: 999_999_999,
    ownerStartTime: 'dead-start',
    ownerToken: 'claim-token',
    createdAtMs: 1,
    updatedAtMs: 1,
  };
  const env = { AGENT_DEVICE_CLAIMS_DIR: path.join(stateDir, 'claims') };
  writeDeviceClaim(claim, env);
  const first = {
    owner: localRuntimeOwner('android'),
    error: new AppError('COMMAND_FAILED', 'Android owner refused', {
      reason: 'android-cleanup-refused',
      hint: 'Inspect Android owner diagnostics.',
      diagnosticId: 'android-owner-diagnostic',
      logPath: '/tmp/android-owner.log',
      ...failureDetails,
    }),
  };
  const second = {
    owner: localRuntimeOwner('apple'),
    error: new AppError('DEVICE_IN_USE', 'Apple owner refused', {
      reason: 'apple-cleanup-refused',
      hint: 'Inspect Apple owner diagnostics.',
      diagnosticId: 'apple-owner-diagnostic',
      logPath: '/tmp/apple-owner.log',
    }),
  };
  const cleanupError = new AppError('COMMAND_FAILED', 'Owner cleanup refused', {
    reason: 'platform-owner-shutdown-failed',
    failures: (failureCount === 1 ? [first] : [first, second]).map(({ owner, error }) => ({
      owner,
      error: normalizeError(error),
    })),
    retriable: false,
  });
  const reconcileOnce = vi.fn(reconcile);
  const emit = vi.fn();
  const dispose = vi.fn(async () => {
    await disposeAfter;
    throw cleanupError;
  });
  const recovery = createOwnerScopedDeviceClaimReconciler({
    scope: {
      signal: new AbortController().signal,
      diagnostics: { emit },
      progress: { report: () => {} },
    },
    composeGateway: () => {
      throw new Error('the supplied recovery owns composition');
    },
    composeRecovery: () => ({ reconcile: reconcileOnce, dispose }),
  });
  const claimPath = resolveDeviceClaimPath(claim.deviceKey, env);
  const claimBytes = fs.readFileSync(claimPath, 'utf8');
  return {
    claim,
    env,
    cleanupError,
    emit,
    dispose,
    recovery,
    reconcileOnce,
    claimPath,
    claimBytes,
  };
}

const expectedFailures = [
  {
    owner: { kind: 'local-family', family: 'android' },
    error: expect.objectContaining({
      code: 'COMMAND_FAILED',
      message: 'Android owner refused',
      hint: 'Inspect Android owner diagnostics.',
      diagnosticId: 'android-owner-diagnostic',
      logPath: '/tmp/android-owner.log',
      details: { reason: 'android-cleanup-refused' },
    }),
  },
  {
    owner: { kind: 'local-family', family: 'apple' },
    error: expect.objectContaining({
      code: 'DEVICE_IN_USE',
      message: 'Apple owner refused',
      hint: 'Inspect Apple owner diagnostics.',
      diagnosticId: 'apple-owner-diagnostic',
      logPath: '/tmp/apple-owner.log',
      details: { reason: 'apple-cleanup-refused' },
    }),
  },
];

test.each([1, 2] as const)(
  'cleanup-only failure keeps the claim and normalizes %i owner failure(s)',
  async (failureCount) => {
    const f = fixture(async () => ({ status: 'reconciled' }), failureCount);

    await expect(settleVerifiedOrphanedClaim(f.claim, f.recovery, f.env)).rejects.toBe(
      f.cleanupError,
    );
    expect(f.emit).toHaveBeenCalledOnce();
    expect(f.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        phase: 'device_claim_recovery_dispose_failed',
        data: expect.objectContaining({
          deviceKey: f.claim.deviceKey,
          ownerSession: f.claim.session,
          error: expect.objectContaining({
            details: {
              reason: 'platform-owner-shutdown-failed',
              failures: expectedFailures.slice(0, failureCount),
            },
          }),
        }),
      }),
    );
    expect(fs.readFileSync(f.claimPath, 'utf8')).toBe(f.claimBytes);
    expect(f.reconcileOnce).toHaveBeenCalledOnce();
    expect(f.dispose).toHaveBeenCalledOnce();
  },
);

test.each([1, 2] as const)(
  'disposal of %i failed owner(s) preserves the primary reconciliation error',
  async (failureCount) => {
    const primary = new AppError('DEVICE_IN_USE', 'reconciliation refused', {
      reason: 'primary-refusal',
    });
    const f = fixture(async () => {
      throw primary;
    }, failureCount);

    await expect(settleVerifiedOrphanedClaim(f.claim, f.recovery, f.env)).rejects.toBe(primary);
    expect(f.emit).toHaveBeenCalledOnce();
    expect(f.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        phase: 'device_claim_recovery_dispose_failed',
        data: expect.objectContaining({
          error: expect.objectContaining({
            code: 'COMMAND_FAILED',
            retriable: false,
            details: {
              reason: 'platform-owner-shutdown-failed',
              failures: expectedFailures.slice(0, failureCount),
            },
          }),
        }),
      }),
    );
    expect(fs.readFileSync(f.claimPath, 'utf8')).toBe(f.claimBytes);
    expect(f.reconcileOnce).toHaveBeenCalledOnce();
    expect(f.dispose).toHaveBeenCalledOnce();
  },
);

test.each([1, 2] as const)(
  'disposal of %i failed owner(s) preserves an existing retained-claim reason',
  async (failureCount) => {
    const retained = { status: 'retained', reason: 'screen-recording-owner-mismatch' } as const;
    const f = fixture(async () => retained, failureCount);

    await expect(settleVerifiedOrphanedClaim(f.claim, f.recovery, f.env)).resolves.toBe(retained);
    expect(fs.readFileSync(f.claimPath, 'utf8')).toBe(f.claimBytes);
    expect(f.emit).toHaveBeenCalledOnce();
    expect(f.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        phase: 'device_claim_recovery_dispose_failed',
        data: expect.objectContaining({
          retainedReason: retained.reason,
          error: expect.objectContaining({
            code: 'COMMAND_FAILED',
            retriable: false,
            details: {
              reason: 'platform-owner-shutdown-failed',
              failures: expectedFailures.slice(0, failureCount),
            },
          }),
        }),
      }),
    );
    expect(f.reconcileOnce).toHaveBeenCalledOnce();
    expect(f.dispose).toHaveBeenCalledOnce();
  },
);

test.each(['primary-error', 'retained'] as const)(
  'bigint disposal details preserve the %s outcome and claim',
  async (outcome) => {
    const primary = new AppError('DEVICE_IN_USE', 'reconciliation refused', {
      reason: 'primary-refusal',
    });
    const retained = { status: 'retained', reason: 'screen-recording-owner-mismatch' } as const;
    const f = fixture(
      async () => {
        if (outcome === 'primary-error') throw primary;
        return retained;
      },
      1,
      { observedAtNs: 9_007_199_254_740_993n, samples: { elapsedNs: [1n, 42n] } },
    );

    const recovery = settleVerifiedOrphanedClaim(f.claim, f.recovery, f.env);
    if (outcome === 'primary-error') await expect(recovery).rejects.toBe(primary);
    else await expect(recovery).resolves.toBe(retained);

    expect(f.emit).toHaveBeenCalledOnce();
    const event = f.emit.mock.calls[0]?.[0];
    expect(event.phase).toBe('device_claim_recovery_dispose_failed');
    expect(event.data.error.details.failures[0].error).toMatchObject({
      code: 'COMMAND_FAILED',
      hint: 'Inspect Android owner diagnostics.',
      diagnosticId: 'android-owner-diagnostic',
      logPath: '/tmp/android-owner.log',
      details: {
        reason: 'android-cleanup-refused',
        observedAtNs: '9007199254740993',
        samples: { elapsedNs: ['1', '42'] },
      },
    });
    if (outcome === 'retained') expect(event.data.retainedReason).toBe(retained.reason);
    expect(fs.readFileSync(f.claimPath, 'utf8')).toBe(f.claimBytes);
    expect(f.reconcileOnce).toHaveBeenCalledOnce();
    expect(f.dispose).toHaveBeenCalledOnce();
  },
);

test.each([
  ['primary-error', 'circular'],
  ['primary-error', 'toJSON'],
  ['primary-error', 'sink'],
  ['retained', 'circular'],
  ['retained', 'toJSON'],
  ['retained', 'sink'],
  ['reconciled', 'circular'],
  ['reconciled', 'toJSON'],
  ['reconciled', 'sink'],
] as const)(
  'preserves %s outcome and claim when secondary diagnostics encounter %s',
  async (outcome, fault) => {
    const primary = new AppError('DEVICE_IN_USE', 'reconciliation refused', {
      reason: 'primary-refusal',
    });
    const retained = { status: 'retained', reason: 'screen-recording-owner-mismatch' } as const;
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const f = fixture(
      async () => {
        if (outcome === 'primary-error') throw primary;
        return outcome === 'retained' ? retained : { status: 'reconciled' };
      },
      1,
      fault === 'circular'
        ? { evidence: circular }
        : fault === 'toJSON'
          ? {
              toJSON: () => {
                throw new Error('serialization hook failed');
              },
            }
          : {},
    );
    if (fault === 'sink')
      f.emit.mockImplementationOnce(() => {
        throw new Error('diagnostic sink failed');
      });
    const recovery = settleVerifiedOrphanedClaim(f.claim, f.recovery, f.env);
    if (outcome === 'primary-error') await expect(recovery).rejects.toBe(primary);
    else if (outcome === 'reconciled') await expect(recovery).rejects.toBe(f.cleanupError);
    else await expect(recovery).resolves.toBe(retained);
    if (fault === 'circular') {
      expect(f.emit).toHaveBeenCalledOnce();
      expect(
        f.emit.mock.calls[0]?.[0].data.error.details.failures[0].error.details.evidence.self,
      ).toBe('[Circular]');
    } else {
      expect(f.emit).toHaveBeenCalledOnce();
      if (fault === 'toJSON') {
        expect(f.emit).toHaveBeenCalledWith({
          level: 'error',
          phase: 'device_claim_recovery_dispose_failed',
          data: {
            deviceKey: f.claim.deviceKey,
            ownerSession: f.claim.session,
            ...(outcome === 'retained' ? { retainedReason: retained.reason } : {}),
            reason: 'diagnostic-data-unserializable',
          },
        });
      }
    }
    expect(fs.readFileSync(f.claimPath, 'utf8')).toBe(f.claimBytes);
    expect(f.reconcileOnce).toHaveBeenCalledOnce();
    expect(f.dispose).toHaveBeenCalledOnce();
  },
);

afterEach(() => {
  vi.useRealTimers();
});

const DISPOSE_BUDGET_MS = 5_000;

test.each(['reconciled', 'retained', 'primary-error'] as const)(
  'a %s outcome survives disposal outliving its budget, and the late failure is still observed',
  async (outcome) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const primary = new AppError('DEVICE_IN_USE', 'reconciliation refused', {
      reason: 'primary-refusal',
    });
    const retained = { status: 'retained', reason: 'screen-recording-owner-mismatch' } as const;
    let releaseDispose!: () => void;
    const f = fixture(
      async () => {
        if (outcome === 'primary-error') throw primary;
        return outcome === 'retained' ? retained : { status: 'reconciled' };
      },
      1,
      {},
      new Promise<void>((resolve) => {
        releaseDispose = resolve;
      }),
    );
    const settlement = settleVerifiedOrphanedClaim(f.claim, f.recovery, f.env);
    const expectation =
      outcome === 'primary-error'
        ? expect(settlement).rejects.toBe(primary)
        : expect(settlement).resolves.toEqual(
            outcome === 'retained'
              ? retained
              : { status: 'retained', reason: 'recovery-dispose-pending' },
          );

    await vi.advanceTimersByTimeAsync(DISPOSE_BUDGET_MS);
    await expectation;
    expect(fs.readFileSync(f.claimPath, 'utf8')).toBe(f.claimBytes);
    expect(f.emit).toHaveBeenCalledOnce();
    expect(f.emit).toHaveBeenCalledWith({
      level: 'warn',
      phase: 'device_claim_recovery_dispose_pending',
      data: {
        deviceKey: f.claim.deviceKey,
        ownerSession: f.claim.session,
        budgetMs: DISPOSE_BUDGET_MS,
        ...(outcome === 'retained' ? { retainedReason: retained.reason } : {}),
      },
    });

    releaseDispose();
    await vi.waitFor(() => expect(f.emit).toHaveBeenCalledTimes(2));
    expect(f.emit).toHaveBeenLastCalledWith({
      level: 'error',
      phase: 'device_claim_recovery_dispose_failed',
      data: expect.objectContaining({
        deviceKey: f.claim.deviceKey,
        afterBudget: true,
        ...(outcome === 'retained' ? { retainedReason: retained.reason } : {}),
        error: expect.objectContaining({
          details: expect.objectContaining({ reason: 'platform-owner-shutdown-failed' }),
        }),
      }),
    });
    expect(fs.readFileSync(f.claimPath, 'utf8')).toBe(f.claimBytes);
    expect(f.dispose).toHaveBeenCalledOnce();
  },
);

test('a late disposal failure after a non-debug request flush is still persisted to the log file', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  const stateDir = mkdtempForTestSync('claim-recovery-late-flush-');
  const logPath = path.join(stateDir, 'request.ndjson');
  const claim: DeviceClaim = {
    schemaVersion: 3,
    claimOwnerKind: 'open-session',
    deviceKey: 'local:android:none:emulator-5554',
    device: { family: 'android', id: 'emulator-5554', name: 'Pixel', kind: 'emulator' },
    session: 'owner-session',
    workspace: '/worktrees/dead',
    stateDir,
    ownerPid: 999_999_999,
    ownerStartTime: 'dead-start',
    ownerToken: 'claim-token',
    createdAtMs: 1,
    updatedAtMs: 1,
  };
  const env = { AGENT_DEVICE_CLAIMS_DIR: path.join(stateDir, 'claims') };
  writeDeviceClaim(claim, env);
  let rejectDispose!: (error: unknown) => void;
  const disposePromise = new Promise<void>((_resolve, reject) => {
    rejectDispose = reject;
  });
  const reconcile = createOwnerScopedDeviceClaimReconciler({
    scope: createRecoveryPlatformScope(),
    composeGateway: () => {
      throw new Error('composeRecovery replaces gateway construction');
    },
    composeRecovery: () => ({
      reconcile: async () => ({ status: 'retained', reason: 'app-log-cleanup-pending' }),
      dispose: async () => await disposePromise,
    }),
  });

  await withDiagnosticsScope(
    { session: 'default', requestId: 'req-late-flush', command: 'open', debug: false, logPath },
    async () => {
      const settlement = settleVerifiedOrphanedClaim(claim, reconcile, env);
      await vi.advanceTimersByTimeAsync(DISPOSE_BUDGET_MS);
      await expect(settlement).resolves.toEqual({
        status: 'retained',
        reason: 'app-log-cleanup-pending',
      });
      flushDiagnosticsToSessionFile({ force: true });
    },
  );

  const readPhases = () =>
    fs
      .readFileSync(logPath, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { phase: string; data?: Record<string, unknown> });

  expect(readPhases().map((entry) => entry.phase)).toEqual([
    'device_claim_recovery_dispose_pending',
  ]);

  rejectDispose(
    new AppError('COMMAND_FAILED', 'Delayed owner shutdown failed', {
      reason: 'platform-owner-shutdown-failed',
    }),
  );

  await vi.waitFor(() => {
    const entries = readPhases();
    expect(entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          phase: 'device_claim_recovery_dispose_failed',
          data: expect.objectContaining({
            afterBudget: true,
            retainedReason: 'app-log-cleanup-pending',
          }),
        }),
      ]),
    );
  });
});
