import { expect, test } from 'vitest';
import fs from 'node:fs';
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
import { requireAllocatorHeldDeviceClaim } from '../device-claim-allocator.ts';
import { canonicalLocalDeviceKey, resolveDeviceClaimPath } from '../device-claim-paths.ts';
import { acquireDeviceClaim, deviceClaimIdentity } from '../device-claims.ts';

const setup = isolatedDeviceClaimStores('agent-device-claim-allocator-');
const owner = managedLocalRuntimeOwner('sim-a');
const fence = managedBindingFence({
  requesterId: 'requester-1',
  requestGeneration: 1,
  identityIncarnationId: 'incarnation-1',
});
const managedBinding: DeviceBindingIntent = { kind: 'exact-owner', owner, fence };

function verify(intent: DeviceBindingIntent) {
  return requireAllocatorHeldDeviceClaim({ device: ANDROID_EMULATOR, owner, intent });
}

test('requireAllocatorHeldDeviceClaim refuses a binding without a managed binding fence before reading the store', () => {
  const { claimsDir } = setup();

  // An ordinary binding, an exact binding of another owner, and an exact binding of this owner
  // under an opaque capture-style fence all fail the managed binding shape.
  expect(verify({ kind: 'ordinary' })).toEqual({ status: 'binding-invalid' });
  expect(verify({ kind: 'exact-owner', owner: localRuntimeOwner('android'), fence })).toEqual({
    status: 'binding-invalid',
  });
  expect(verify({ kind: 'exact-owner', owner, fence: { token: 'fence', generation: 1 } })).toEqual({
    status: 'binding-invalid',
  });
  expect(fs.existsSync(claimsDir)).toBe(false);
});

test('requireAllocatorHeldDeviceClaim reports a missing claim without creating the store', () => {
  const { claimsDir } = setup();

  expect(verify(managedBinding)).toEqual({ status: 'missing' });
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
  const claimPath = resolveDeviceClaimPath(
    canonicalLocalDeviceKey(deviceClaimIdentity(ANDROID_EMULATOR)),
  );
  const before = fs.readFileSync(claimPath, 'utf8');

  const outcome = verify(managedBinding);

  expect(outcome.status).toBe('conflict');
  if (outcome.status !== 'conflict') return;
  expect(outcome.conflict.classification).toBe('live');
  expect(outcome.conflict.claim?.session).toBe('owner-session');
  // Read-only: the record is byte-identical, no lock directory was taken, and nothing else
  // appeared in the store.
  expect(fs.readFileSync(claimPath, 'utf8')).toBe(before);
  expect(fs.existsSync(`${claimPath}.lock`)).toBe(false);
  expect(fs.readdirSync(claimsDir)).toHaveLength(1);
});
