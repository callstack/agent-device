import fs from 'node:fs';
import path from 'node:path';
import { expect, test, vi } from 'vitest';
import { mkdtempForTestSync } from '@agent-device/test-kit';
import { AppError, normalizeError } from '@agent-device/kernel/errors';
import { localRuntimeOwner } from '@agent-device/contracts/platform-runtime';
import { createPlatformRuntimeShutdownError } from '@agent-device/contracts/platform-runtime-shutdown';
import {
  emitDiagnostic,
  flushDiagnosticsToSessionFile,
  withDiagnosticsScope,
} from '@agent-device/host-kit/diagnostics';
import {
  createOwnerScopedDeviceClaimReconciler,
  type OwnerScopedClaimRecovery,
} from './device-claim-owner-recovery.ts';
import type { DeviceClaim } from './device-claims.ts';
import { resolveDeviceClaimPath } from './device-claim-paths.ts';
import { writeDeviceClaim } from './device-claim-store.ts';
import { settleVerifiedOrphanedClaim } from './device-claim-settlement.ts';

function fixture(reconcile: OwnerScopedClaimRecovery['reconcile'], failureCount: 1 | 2) {
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
  const cleanupError = createPlatformRuntimeShutdownError(
    failureCount === 1 ? [first] : [first, second],
  );
  const reconcileOnce = vi.fn(reconcile);
  const logPath = path.join(stateDir, 'recovery.ndjson');
  const dispose = vi.fn(async () => {
    throw cleanupError;
  });
  const recovery = createOwnerScopedDeviceClaimReconciler({
    scope: {
      signal: new AbortController().signal,
      diagnostics: { emit: emitDiagnostic },
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
    logPath,
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
    const normalized = normalizeError(f.cleanupError);
    expect(JSON.parse(JSON.stringify(normalized))).toMatchObject({
      code: 'COMMAND_FAILED',
      retriable: false,
      details: {
        reason: 'platform-owner-shutdown-failed',
        failures: expectedFailures.slice(0, failureCount),
      },
    });
    expect(normalized.message).toContain('android: Android owner refused');
    if (failureCount === 2) expect(normalized.message).toContain('apple: Apple owner refused');
    expect(normalized.hint).toContain('Cleanup is unconfirmed');
    expect(normalized.hint).toContain('claim is still held');
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

    await withDiagnosticsScope({ logPath: f.logPath }, async () => {
      await expect(settleVerifiedOrphanedClaim(f.claim, f.recovery, f.env)).rejects.toBe(primary);
      flushDiagnosticsToSessionFile({ force: true });
    });
    expect(JSON.parse(fs.readFileSync(f.logPath, 'utf8'))).toEqual(
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

    await withDiagnosticsScope({ logPath: f.logPath }, async () => {
      await expect(settleVerifiedOrphanedClaim(f.claim, f.recovery, f.env)).resolves.toBe(retained);
      flushDiagnosticsToSessionFile({ force: true });
    });
    expect(fs.readFileSync(f.claimPath, 'utf8')).toBe(f.claimBytes);
    expect(JSON.parse(fs.readFileSync(f.logPath, 'utf8'))).toEqual(
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
