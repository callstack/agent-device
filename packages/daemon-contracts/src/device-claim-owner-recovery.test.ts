import fs from 'node:fs';
import path from 'node:path';
import { expect, test, vi } from 'vitest';
import { mkdtempForTestSync } from '@agent-device/test-kit';
import { AppError } from '@agent-device/kernel/errors';
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

function fixture(reconcile: OwnerScopedClaimRecovery['reconcile']) {
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
  const cleanupError = new AppError('COMMAND_FAILED', 'owner disposal failed', {
    reason: 'owner-cleanup-refused',
  });
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
    composeRecovery: () => ({ reconcile, dispose }),
  });
  return { claim, env, cleanupError, logPath, dispose, recovery };
}

test('cleanup-only failure prevents a reconciled claim from being released', async () => {
  const f = fixture(async () => ({ status: 'reconciled' }));

  await expect(settleVerifiedOrphanedClaim(f.claim, f.recovery, f.env)).rejects.toBe(
    f.cleanupError,
  );
  expect(fs.existsSync(resolveDeviceClaimPath(f.claim.deviceKey, f.env))).toBe(true);
  expect(f.dispose).toHaveBeenCalledOnce();
});

test('disposal failure preserves the primary reconciliation error and records secondary evidence', async () => {
  const primary = new AppError('DEVICE_IN_USE', 'reconciliation refused', {
    reason: 'primary-refusal',
  });
  const f = fixture(async () => {
    throw primary;
  });

  await withDiagnosticsScope({ logPath: f.logPath }, async () => {
    await expect(f.recovery(f.claim)).rejects.toBe(primary);
    flushDiagnosticsToSessionFile({ force: true });
  });
  expect(JSON.parse(fs.readFileSync(f.logPath, 'utf8'))).toEqual(
    expect.objectContaining({
      phase: 'device_claim_recovery_dispose_failed',
      data: expect.objectContaining({
        error: expect.objectContaining({ details: { reason: 'owner-cleanup-refused' } }),
      }),
    }),
  );
  expect(f.dispose).toHaveBeenCalledOnce();
});

test('disposal failure preserves an existing retained-claim reason', async () => {
  const retained = { status: 'retained', reason: 'screen-recording-owner-mismatch' } as const;
  const f = fixture(async () => retained);

  await withDiagnosticsScope({ logPath: f.logPath }, async () => {
    await expect(settleVerifiedOrphanedClaim(f.claim, f.recovery, f.env)).resolves.toBe(retained);
    flushDiagnosticsToSessionFile({ force: true });
  });
  expect(fs.existsSync(resolveDeviceClaimPath(f.claim.deviceKey, f.env))).toBe(true);
  expect(JSON.parse(fs.readFileSync(f.logPath, 'utf8'))).toEqual(
    expect.objectContaining({
      phase: 'device_claim_recovery_dispose_failed',
      data: expect.objectContaining({ retainedReason: retained.reason }),
    }),
  );
  expect(f.dispose).toHaveBeenCalledOnce();
});
