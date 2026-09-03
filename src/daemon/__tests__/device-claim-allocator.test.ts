import { expect, test, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  localRuntimeOwner,
  managedBindingFence,
  managedLocalRuntimeOwner,
  type DeviceBindingIntent,
} from '@agent-device/contracts/platform-runtime';
import { ANDROID_EMULATOR } from '../../__tests__/test-utils/device-fixtures.ts';
import {
  isolatedDeviceClaimStores,
  retainOrphanedDeviceClaims,
} from '../../__tests__/test-utils/device-claim-store.ts';
import {
  acquireAllocatorHeldDeviceClaim,
  inspectAllocatorHeldDeviceClaim,
  releaseAllocatorHeldClaim,
  requireAllocatorHeldDeviceClaim,
  type AllocatorHeldClaimPrincipal,
} from '../device-claim-allocator.ts';
import {
  deviceClaimOwnerCannotRelease,
  deviceClaimRequiresStaleInspection,
} from '../device-claim-inspection.ts';
import { canonicalLocalDeviceKey, resolveDeviceClaimPath } from '../device-claim-paths.ts';
import { acquireDeviceClaim, deviceClaimIdentity } from '../device-claims.ts';

vi.mock('@agent-device/host-kit/process', async (importOriginal) =>
  (await import('../../__tests__/test-utils/host-process-mock.ts')).pinOwnProcessStartTime(
    importOriginal,
  ),
);

const setup = isolatedDeviceClaimStores('agent-device-claim-allocator-');
const owner = managedLocalRuntimeOwner('sim-a');
const fence = managedBindingFence({
  requesterId: 'requester-1',
  requestGeneration: 1,
  identityIncarnationId: 'incarnation-1',
});
const managedBinding: DeviceBindingIntent = { kind: 'exact-owner', owner, fence };

const claimPath = () =>
  resolveDeviceClaimPath(canonicalLocalDeviceKey(deviceClaimIdentity(ANDROID_EMULATOR)));

function principal(
  stateDir: string,
  overrides: Partial<AllocatorHeldClaimPrincipal> = {},
): AllocatorHeldClaimPrincipal {
  return {
    stateDir,
    instanceId: 'sim-a',
    identityIncarnationId: 'incarnation-1',
    ...overrides,
  };
}

async function acquireHeld(stateDir: string, overrides: Partial<AllocatorHeldClaimPrincipal> = {}) {
  return await acquireAllocatorHeldDeviceClaim({
    device: ANDROID_EMULATOR,
    principal: principal(stateDir, overrides),
  });
}

/** One field of the principal wrong at a time; each alone must refuse. */
function principalMismatches(root: string): Partial<AllocatorHeldClaimPrincipal>[] {
  return [
    { stateDir: path.join(root, 'other-installation') },
    { instanceId: 'sim-b' },
    { identityIncarnationId: 'incarnation-2' },
  ];
}

function verify(intent: DeviceBindingIntent, stateDir: string) {
  return requireAllocatorHeldDeviceClaim({ device: ANDROID_EMULATOR, owner, stateDir, intent });
}

test('requireAllocatorHeldDeviceClaim refuses a binding without a managed binding fence before reading the store', () => {
  const { stateDir, claimsDir } = setup();

  // An ordinary binding, an exact binding of another owner, and an exact binding of this owner
  // under an opaque capture-style fence all fail the managed binding shape.
  expect(verify({ kind: 'ordinary' }, stateDir)).toEqual({ status: 'binding-invalid' });
  expect(
    verify({ kind: 'exact-owner', owner: localRuntimeOwner('android'), fence }, stateDir),
  ).toEqual({ status: 'binding-invalid' });
  expect(
    verify({ kind: 'exact-owner', owner, fence: { token: 'fence', generation: 1 } }, stateDir),
  ).toEqual({ status: 'binding-invalid' });
  expect(fs.existsSync(claimsDir)).toBe(false);
});

test('requireAllocatorHeldDeviceClaim reports a missing claim without creating the store', () => {
  const { stateDir, claimsDir } = setup();

  expect(verify(managedBinding, stateDir)).toEqual({ status: 'missing' });
  expect(fs.existsSync(claimsDir)).toBe(false);
});

test('requireAllocatorHeldDeviceClaim reports a foreign live claim as a conflict and never touches it', async () => {
  const { stateDir, claimsDir } = setup();
  await acquireDeviceClaim({
    device: ANDROID_EMULATOR,
    session: 'owner-session',
    workspace: '/worktrees/foreign',
    stateDir,
    reconcileOrphanedDeviceClaim: retainOrphanedDeviceClaims,
  });
  const before = fs.readFileSync(claimPath(), 'utf8');

  const outcome = verify(managedBinding, stateDir);

  expect(outcome.status).toBe('conflict');
  if (outcome.status !== 'conflict') return;
  expect(outcome.conflict.classification).toBe('live');
  expect(outcome.conflict.claim?.session).toBe('owner-session');
  // Read-only: the record is byte-identical, no lock directory was taken, and nothing else
  // appeared in the store.
  expect(fs.readFileSync(claimPath(), 'utf8')).toBe(before);
  expect(fs.existsSync(`${claimPath()}.lock`)).toBe(false);
  expect(fs.readdirSync(claimsDir)).toHaveLength(1);
});

test('an allocator-held claim is acquired with the installation principal and reattached only on the full principal', async () => {
  const { root, stateDir } = setup();

  expect(await acquireHeld(stateDir)).toEqual({ status: 'acquired' });
  const record = JSON.parse(fs.readFileSync(claimPath(), 'utf8')) as Record<string, unknown>;
  expect(record.schemaVersion).toBe(3);
  expect(record.kind).toBe('allocator');
  expect(record.allocator).toEqual({ instanceId: 'sim-a', identityIncarnationId: 'incarnation-1' });
  expect(record.stateDir).toBe(stateDir);
  // No process principal is ever written, so no ownership match can find one.
  for (const field of ['ownerPid', 'ownerStartTime', 'ownerToken', 'session', 'workspace']) {
    expect(record[field]).toBeUndefined();
  }

  // A restarted daemon of the same installation reattaches; the created-at timestamp survives.
  expect(await acquireHeld(stateDir)).toEqual({ status: 'reattached' });
  const reattached = JSON.parse(fs.readFileSync(claimPath(), 'utf8')) as Record<string, unknown>;
  expect(reattached.createdAtMs).toBe(record.createdAtMs);

  // Each field of the principal alone is enough to refuse, and the file is left as it was.
  const before = fs.readFileSync(claimPath(), 'utf8');
  for (const mismatch of principalMismatches(root)) {
    const outcome = await acquireAllocatorHeldDeviceClaim({
      device: ANDROID_EMULATOR,
      principal: { ...principal(stateDir), ...mismatch },
    });
    expect(outcome.status).toBe('conflict');
    if (outcome.status !== 'conflict') return;
    expect(outcome.conflict.classification).toBe('allocator-held');
    expect(fs.readFileSync(claimPath(), 'utf8')).toBe(before);
  }
});

test('acquireAllocatorHeldDeviceClaim never reconciles or supersedes an ordinary claim', async () => {
  const { root, stateDir } = setup();
  const deadStateDir = path.join(root, 'dead');
  fs.mkdirSync(deadStateDir, { recursive: true });
  fs.mkdirSync(path.dirname(claimPath()), { recursive: true });
  fs.writeFileSync(
    claimPath(),
    JSON.stringify({
      schemaVersion: 2,
      deviceKey: canonicalLocalDeviceKey(deviceClaimIdentity(ANDROID_EMULATOR)),
      device: { family: 'android', id: 'emulator-5554', name: 'Pixel', kind: 'emulator' },
      session: 'dead-session',
      workspace: '/worktrees/dead',
      stateDir: deadStateDir,
      ownerPid: 999_999_999,
      ownerStartTime: 'long-gone',
      ownerToken: 'dead-token',
      createdAtMs: 1,
      updatedAtMs: 1,
    }),
  );
  const before = fs.readFileSync(claimPath(), 'utf8');

  const outcome = await acquireHeld(stateDir);

  // A provably dead ordinary owner is exactly what `--stale` and the startup sweep settle; the
  // allocator path refuses instead of replacing a record it cannot reconcile.
  expect(outcome.status).toBe('conflict');
  if (outcome.status !== 'conflict') return;
  expect(outcome.conflict.classification).toBe('owner-process-dead');
  expect(fs.readFileSync(claimPath(), 'utf8')).toBe(before);
});

test('requireAllocatorHeldDeviceClaim covers only the local allocator-held claim at the fenced identity incarnation', async () => {
  const { root, stateDir } = setup();
  await acquireHeld(stateDir);

  expect(verify(managedBinding, stateDir)).toEqual({ status: 'covered' });

  // Another installation holding the same device is a conflict, not coverage.
  const foreign = verify(managedBinding, path.join(root, 'other-installation'));
  expect(foreign.status).toBe('conflict');
  if (foreign.status !== 'conflict') return;
  expect(foreign.conflict.classification).toBe('allocator-held');

  // So is another allocator instance, matched through the derived managed owner.
  const otherInstance = requireAllocatorHeldDeviceClaim({
    device: ANDROID_EMULATOR,
    owner: managedLocalRuntimeOwner('sim-b'),
    stateDir,
    intent: { kind: 'exact-owner', owner: managedLocalRuntimeOwner('sim-b'), fence },
  });
  expect(otherInstance.status).toBe('conflict');

  // A fence for a re-provisioned identity is stale, never covered: the incarnation is stable for
  // the identity's pool lifetime, so a different one means the old grant is gone.
  expect(
    verify(
      {
        kind: 'exact-owner',
        owner,
        fence: managedBindingFence({
          requesterId: 'requester-1',
          requestGeneration: 2,
          identityIncarnationId: 'incarnation-2',
        }),
      },
      stateDir,
    ),
  ).toEqual({ status: 'incarnation-stale', heldIncarnationId: 'incarnation-1' });
});

test('releaseAllocatorHeldClaim clears only with matching removal proof and never a process-owned claim', async () => {
  const { root, stateDir } = setup();

  expect(
    await releaseAllocatorHeldClaim({
      device: ANDROID_EMULATOR,
      removalProof: principal(stateDir),
    }),
  ).toBe('absent');

  await acquireHeld(stateDir);
  const before = fs.readFileSync(claimPath(), 'utf8');
  for (const mismatch of principalMismatches(root)) {
    expect(
      await releaseAllocatorHeldClaim({
        device: ANDROID_EMULATOR,
        removalProof: { ...principal(stateDir), ...mismatch },
      }),
    ).toBe('ownership-changed');
    expect(fs.readFileSync(claimPath(), 'utf8')).toBe(before);
  }
  expect(
    await releaseAllocatorHeldClaim({
      device: ANDROID_EMULATOR,
      removalProof: principal(stateDir),
    }),
  ).toBe('released');
  expect(fs.existsSync(claimPath())).toBe(false);

  // A process-owned claim is not the allocator's to remove, however complete the proof.
  await acquireDeviceClaim({
    device: ANDROID_EMULATOR,
    session: 'owner-session',
    workspace: '/worktrees/session',
    stateDir,
    reconcileOrphanedDeviceClaim: retainOrphanedDeviceClaims,
  });
  const sessionClaim = fs.readFileSync(claimPath(), 'utf8');
  expect(
    await releaseAllocatorHeldClaim({
      device: ANDROID_EMULATOR,
      removalProof: principal(stateDir),
    }),
  ).toBe('ownership-changed');
  expect(fs.readFileSync(claimPath(), 'utf8')).toBe(sessionClaim);
});

test('inspectAllocatorHeldDeviceClaim answers only for an allocator-held record', async () => {
  const { stateDir } = setup();

  expect(inspectAllocatorHeldDeviceClaim(ANDROID_EMULATOR)).toBeNull();

  await acquireDeviceClaim({
    device: ANDROID_EMULATOR,
    session: 'owner-session',
    workspace: '/worktrees/session',
    stateDir,
    reconcileOrphanedDeviceClaim: retainOrphanedDeviceClaims,
  });
  expect(inspectAllocatorHeldDeviceClaim(ANDROID_EMULATOR)).toBeNull();

  fs.rmSync(claimPath());
  await acquireHeld(stateDir);
  expect(inspectAllocatorHeldDeviceClaim(ANDROID_EMULATOR)?.allocatorClaim?.allocator).toEqual({
    instanceId: 'sim-a',
    identityIncarnationId: 'incarnation-1',
  });
});

test('the allocator-held classification is neither stale nor owner-releasable', () => {
  // Both predicates are proofs about an owner PROCESS. An allocator-held claim has none, so it is
  // never hidden from `device status`, never offered to the startup sweep, and never released by
  // `device release --stale`. Every reader also reaches for `entry.claim`, which is undefined for
  // this kind, so these answers are the second fence rather than the first.
  expect(deviceClaimRequiresStaleInspection('allocator-held')).toBe(false);
  expect(deviceClaimOwnerCannotRelease('allocator-held')).toBe(false);
});
