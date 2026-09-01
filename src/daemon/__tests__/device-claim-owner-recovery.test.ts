import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { DeviceClaim } from '../device-claims.ts';
import { createOwnerScopedDeviceClaimReconciler } from '../device-claim-owner-recovery.ts';

const scope = {
  signal: new AbortController().signal,
  diagnostics: { emit: () => {} },
  progress: { report: () => {} },
};

function makeClaim(stateDir: string, session: string): DeviceClaim {
  return {
    schemaVersion: 2,
    deviceKey: `local:android:none:${session}`,
    device: { family: 'android', id: session, name: 'Pixel', kind: 'emulator' },
    session,
    workspace: `/worktrees/${session}`,
    stateDir,
    ownerPid: 999_999_999,
    ownerStartTime: 'dead-start',
    ownerToken: `${session}-token`,
    createdAtMs: 1,
    updatedAtMs: 1,
  };
}

test('composes one recovery per claim from that claim state dir and disposes it', async () => {
  const events: string[] = [];
  const reconcile = createOwnerScopedDeviceClaimReconciler(scope, (stateDir) => ({
    reconcile: async (claim) => {
      assert.equal(claim.stateDir, stateDir);
      events.push(`reconcile:${stateDir}`);
      return { status: 'reconciled' };
    },
    dispose: async () => {
      events.push(`dispose:${stateDir}`);
    },
  }));

  await reconcile(makeClaim('/state/owner-a', 'shared'));
  await reconcile(makeClaim('/state/owner-b', 'shared'));

  assert.deepEqual(events, [
    'reconcile:/state/owner-a',
    'dispose:/state/owner-a',
    'reconcile:/state/owner-b',
    'dispose:/state/owner-b',
  ]);
});

test('disposes the composed recovery when reconciliation retains or throws', async () => {
  const disposed: string[] = [];
  const retainReconcile = createOwnerScopedDeviceClaimReconciler(scope, (stateDir) => ({
    reconcile: async () => ({ status: 'retained', reason: 'cleanup-pending' }),
    dispose: async () => {
      disposed.push(stateDir);
    },
  }));
  const result = await retainReconcile(makeClaim('/state/retained', 'shared'));
  assert.deepEqual(result, { status: 'retained', reason: 'cleanup-pending' });

  const throwingReconcile = createOwnerScopedDeviceClaimReconciler(scope, (stateDir) => ({
    reconcile: async () => {
      throw new Error('recovery exploded');
    },
    dispose: async () => {
      disposed.push(stateDir);
    },
  }));
  await assert.rejects(
    async () => await throwingReconcile(makeClaim('/state/thrown', 'shared')),
    /recovery exploded/,
  );
  assert.deepEqual(disposed, ['/state/retained', '/state/thrown']);
});
