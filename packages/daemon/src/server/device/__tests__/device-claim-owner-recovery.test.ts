import {
  createOwnerScopedDeviceClaimReconciler,
  inspectDeviceClaimRecovery,
  type OwnerScopedClaimRecoveryComposer,
} from '@agent-device/daemon-contracts/device-claim-recovery';
import { appLogResourceStore } from '@agent-device/capture-kit/app-log-durable-resource';
import { screenRecordingDurableResource } from '@agent-device/capture-kit/screen-recording-session-resource';
import { createDurableResourceEnvelope } from '@agent-device/capture-kit';
import { localRuntimeOwner } from '@agent-device/contracts/platform-runtime';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { expect, test, vi } from 'vitest';
import { mkdtempForTestSync } from '@agent-device/test-kit';
import type { AppLogSessionArtifacts } from '@agent-device/contracts/app-log-runtime';
import type { OwnedProcessRecordWriter } from '@agent-device/contracts/platform-runtime-host';
import type { DeviceClaim } from '@agent-device/daemon-contracts/device-claims';

const scope = {
  signal: new AbortController().signal,
  diagnostics: { emit: () => {} },
  progress: { report: () => {} },
};

function makeClaim(stateDir: string, session: string): DeviceClaim {
  return {
    schemaVersion: 3,
    claimOwnerKind: 'open-session',
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

test('a retained owner decision stops recovery before gateway composition', async () => {
  const events: string[] = [];
  const claim = makeClaim('/state/blocked', 'shared');
  const reconcile = createOwnerScopedDeviceClaimReconciler({
    scope,
    beforeGateway: async (current) => {
      assert.equal(current, claim);
      events.push('inspect');
      return { status: 'retained', reason: 'resource-recovery-requires-standalone' };
    },
    composeGateway: () => {
      events.push('gateway');
      throw new Error('gateway must not be composed');
    },
  });
  assert.deepEqual(await reconcile(claim), {
    status: 'retained',
    reason: 'resource-recovery-requires-standalone',
  });
  assert.deepEqual(events, ['inspect']);
});

test('unreadable durable evidence prevents owner-scoped gateway construction', async () => {
  const stateDir = mkdtempForTestSync('device-claim-unreadable-owner-');
  const claim = makeClaim(stateDir, 'claimed-session');
  const resourcePath = appLogResourceStore.resolvePath(
    path.join(stateDir, 'sessions', claim.session),
  );
  fs.mkdirSync(path.dirname(resourcePath), { recursive: true });
  fs.writeFileSync(resourcePath, '{');
  const reconcile = createOwnerScopedDeviceClaimReconciler({
    scope,
    beforeGateway: inspectDeviceClaimRecovery,
    composeGateway: () => {
      throw new Error('gateway must not be composed');
    },
  });
  expect(await reconcile(claim)).toEqual({
    status: 'retained',
    reason: 'app-log-descriptor-invalid',
  });
  expect(fs.readFileSync(resourcePath, 'utf8')).toBe('{');
});

test('owner-scoped recovery uses its pre-gateway ownership decision for terminal cleanup', async () => {
  const stateDir = mkdtempForTestSync('device-claim-terminal-owner-');
  const claim = makeClaim(stateDir, 'claimed-session');
  const resourcePath = appLogResourceStore.resolvePath(
    path.join(stateDir, 'sessions', claim.session),
  );
  const screenPath = screenRecordingDurableResource.store.resolvePath(
    path.join(stateDir, 'sessions', claim.session),
  );
  appLogResourceStore.write(
    resourcePath,
    createDurableResourceEnvelope({
      resourceKind: 'app-log',
      sessionId: claim.session,
      device: claim.device,
      owner: localRuntimeOwner('android'),
      fence: { token: 'fence', generation: 1 },
      lifecycle: 'completed',
      descriptor: { version: 1, body: { pid: 123 } },
    }),
  );
  screenRecordingDurableResource.store.write(
    screenPath,
    createDurableResourceEnvelope({
      resourceKind: 'screen-recording',
      sessionId: claim.session,
      device: claim.device,
      owner: localRuntimeOwner('android'),
      fence: { token: 'fence', generation: 1 },
      lifecycle: 'completed',
      descriptor: { version: 1, body: {} },
    }),
  );
  const openedPaths: string[] = [];
  const originalOpen = fs.openSync;
  const open = vi.spyOn(fs, 'openSync').mockImplementation((...args) => {
    if (args[0] === resourcePath || args[0] === screenPath) openedPaths.push(args[0]);
    return originalOpen(...args);
  });
  const shutdown = vi.fn(async () => {});
  const bind = vi.fn();
  try {
    const reconcile = createOwnerScopedDeviceClaimReconciler({
      scope,
      beforeGateway: inspectDeviceClaimRecovery,
      composeGateway: () => ({ bind, shutdown }) as never,
    });
    expect(await reconcile(claim)).toEqual({ status: 'reconciled' });
    expect(openedPaths.slice(0, 2)).toEqual([resourcePath, screenPath]);
    expect(bind).not.toHaveBeenCalled();
    expect(shutdown).toHaveBeenCalledOnce();
    expect(appLogResourceStore.read(resourcePath)).toMatchObject({
      status: 'decoded',
      envelope: { lifecycle: 'completed' },
    });
  } finally {
    open.mockRestore();
  }
  expect(inspectDeviceClaimRecovery(claim)).toEqual({
    status: 'inspectable',
    recoveryKinds: [],
    ownedResources: [
      { resourceKind: 'app-log', resourcePath },
      { resourceKind: 'screen-recording', resourcePath: screenPath },
    ],
  });
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
// assembles therefore has to be fed the claim's own paths — a gateway built from the reconciling
// daemon's paths would clear a same-named live session's owned-process records.
test('the default composition hands the gateway factory the claim owner state dir', async () => {
  const ownerA = mkdtempForTestSync('agent-device-claim-owner-a-');
  const ownerB = mkdtempForTestSync('agent-device-claim-owner-b-');
  const composed: {
    sessionsDir: string;
    ownedProcesses?: OwnedProcessRecordWriter;
    resolveSessionArtifacts: (sessionId: string) => AppLogSessionArtifacts;
  }[] = [];
  const shutdowns: string[] = [];
  const reconcile = createOwnerScopedDeviceClaimReconciler({
    scope,
    composeGateway: (input) => {
      composed.push(input);
      return {
        shutdown: async () => {
          shutdowns.push(input.sessionsDir);
        },
      } as never;
    },
  });

  const outcomeA = await reconcile(makeClaim(ownerA, 'shared'));
  const outcomeB = await reconcile(makeClaim(ownerB, 'shared'));

  assert.deepEqual([outcomeA, outcomeB], [{ status: 'reconciled' }, { status: 'reconciled' }]);
  // Paths are derived per transaction from the CLAIM's state dir, so a same-named session under
  // another owner never shares a store. Writing through each composed store and asserting where
  // the record lands pins the #2168 hazard: a store bound to the reconciling process's dirs (or
  // to the first claim's) would write under the wrong owner's session dir.
  assert.deepEqual(
    composed.map((input) => input.sessionsDir),
    [path.join(ownerA, 'sessions'), path.join(ownerB, 'sessions')],
  );
  const record = { pid: 4242, startTime: 'dead-start', command: 'adb', purpose: 'test' } as const;
  composed.forEach((input, index) => {
    input.ownedProcesses!.replace({ kind: 'session', sessionId: 'shared' }, [record]);
    const owner = index === 0 ? ownerA : ownerB;
    assert.equal(
      fs.existsSync(path.join(owner, 'sessions', 'shared', 'owned-processes.json')),
      true,
      `owned-process record for session 'shared' must land under the claim owner's dir (${owner})`,
    );
  });
  assert.notEqual(composed[0]!.sessionsDir, composed[1]!.sessionsDir);
  assert.ok(composed.every((input) => typeof input.resolveSessionArtifacts === 'function'));
  // Disposal follows composition, so a later claim never runs on an earlier owner's gateway.
  assert.deepEqual(shutdowns, [path.join(ownerA, 'sessions'), path.join(ownerB, 'sessions')]);
});
