import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'vitest';
import { mkdtempForTestSync } from '../../../__tests__/test-utils/tmp-dir.ts';
import type { DeviceClaim } from '../device-claim-record.ts';
import {
  createOwnerScopedDeviceClaimReconciler,
  type OwnerScopedClaimRecoveryComposer,
} from '../device-claim-owner-recovery.ts';

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

const composerAs = (compose: OwnerScopedClaimRecoveryComposer): OwnerScopedClaimRecoveryComposer =>
  compose;

test('composes one recovery per claim from that claim state dir and disposes it', async () => {
  const events: string[] = [];
  const reconcile = createOwnerScopedDeviceClaimReconciler({
    scope,
    composeGateway: () => {
      throw new Error('test composes through composeRecovery');
    },
    composeRecovery: composerAs((stateDir) => ({
      reconcile: async (claim) => {
        assert.equal(claim.stateDir, stateDir);
        events.push(`reconcile:${stateDir}`);
        return { status: 'reconciled' };
      },
      dispose: async () => {
        events.push(`dispose:${stateDir}`);
      },
    })),
  });

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
  const retainReconcile = createOwnerScopedDeviceClaimReconciler({
    scope,
    composeGateway: () => {
      throw new Error('test composes through composeRecovery');
    },
    composeRecovery: composerAs((stateDir) => ({
      reconcile: async () => ({ status: 'retained', reason: 'cleanup-pending' }),
      dispose: async () => {
        disposed.push(stateDir);
      },
    })),
  });
  const result = await retainReconcile(makeClaim('/state/retained', 'shared'));
  assert.deepEqual(result, { status: 'retained', reason: 'cleanup-pending' });

  const throwingReconcile = createOwnerScopedDeviceClaimReconciler({
    scope,
    composeGateway: () => {
      throw new Error('test composes through composeRecovery');
    },
    composeRecovery: composerAs((stateDir) => ({
      reconcile: async () => {
        throw new Error('recovery exploded');
      },
      dispose: async () => {
        disposed.push(stateDir);
      },
    })),
  });
  await assert.rejects(
    async () => await throwingReconcile(makeClaim('/state/thrown', 'shared')),
    /recovery exploded/,
  );
  assert.deepEqual(disposed, ['/state/retained', '/state/thrown']);
});

// #2168: recovery has to rebuild the DEAD owner's world. The gateway the default composition
// assembles therefore has to be fed the claim's own state dir — a gateway built from the
// reconciling daemon's paths would clear a same-named live session's owned-process records.
test('the default composition hands the gateway factory the claim owner state dir', async () => {
  const ownerA = mkdtempForTestSync('agent-device-claim-owner-a-');
  const ownerB = mkdtempForTestSync('agent-device-claim-owner-b-');
  const composed: {
    stateDir: string;
    sessionsDir: string;
    ownedProcesses?: unknown;
    resolveSessionArtifacts: unknown;
  }[] = [];
  const shutdowns: string[] = [];
  const reconcile = createOwnerScopedDeviceClaimReconciler({
    scope,
    composeGateway: (input) => {
      composed.push(input);
      return {
        shutdown: async () => {
          shutdowns.push(input.stateDir);
        },
      } as never;
    },
  });

  const outcomeA = await reconcile(makeClaim(ownerA, 'shared'));
  const outcomeB = await reconcile(makeClaim(ownerB, 'shared'));

  assert.deepEqual([outcomeA, outcomeB], [{ status: 'reconciled' }, { status: 'reconciled' }]);
  assert.deepEqual(
    composed.map((input) => input.stateDir),
    [ownerA, ownerB],
  );
  // Paths are derived per transaction, and the owned-process store exists so recording cleanup
  // clears records through the dead owner's store rather than this process's.
  assert.deepEqual(
    composed.map((input) => input.sessionsDir),
    [path.join(ownerA, 'sessions'), path.join(ownerB, 'sessions')],
  );
  assert.ok(composed.every((input) => input.ownedProcesses !== undefined));
  assert.ok(composed.every((input) => typeof input.resolveSessionArtifacts === 'function'));
  // Disposal follows composition, so a later claim never runs on an earlier owner's gateway.
  assert.deepEqual(shutdowns, [ownerA, ownerB]);
});
