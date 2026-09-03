import { expect, test } from 'vitest';
import { managedLocalRuntimeOwner } from '@agent-device/contracts/platform-runtime';
import {
  allocatorHeldClaimOwner,
  decodeStoredDeviceClaim,
  isAllocatorHeldDeviceClaim,
} from '../device-claim-record.ts';

const DEVICE_KEY = 'local:android:none:emulator-5554';

function legacyClaim(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    deviceKey: DEVICE_KEY,
    device: { platform: 'android', id: 'emulator-5554', name: 'Pixel', kind: 'emulator' },
    session: 'work',
    workspace: '/worktrees/x',
    stateDir: '/state/x',
    ownerPid: 4242,
    ownerStartTime: 'start',
    ownerToken: 'token',
    createdAtMs: 1,
    updatedAtMs: 2,
    ...overrides,
  };
}

function currentClaim(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...legacyClaim(),
    schemaVersion: 2,
    device: { family: 'android', id: 'emulator-5554', name: 'Pixel', kind: 'emulator' },
    ...overrides,
  };
}

function allocatorClaim(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 3,
    kind: 'allocator',
    deviceKey: DEVICE_KEY,
    device: { family: 'android', id: 'emulator-5554', name: 'Pixel', kind: 'emulator' },
    stateDir: '/state/host',
    allocator: { instanceId: 'sim-a', identityIncarnationId: 'inc-1' },
    createdAtMs: 1,
    updatedAtMs: 2,
    ...overrides,
  };
}

test('v1 and v2 records decode to the process-owned claim with its process principal intact', () => {
  // The process-owned record is untouched by the allocator kind: the same v1 migration and the
  // same v2 shape, at the same schema version, so a daemon that predates v3 still reads them.
  for (const raw of [legacyClaim(), currentClaim()]) {
    const record = decodeStoredDeviceClaim(raw);
    expect(record).not.toBeNull();
    if (!record || isAllocatorHeldDeviceClaim(record)) throw new Error('expected process-owned');
    expect(record.schemaVersion).toBe(2);
    expect(record.session).toBe('work');
    expect(record.ownerPid).toBe(4242);
    expect(record.ownerToken).toBe('token');
  }
  expect(
    decodeStoredDeviceClaim(legacyClaim({ session: 'transient:install' }))?.schemaVersion,
  ).toBe(2);
});

test('an allocator-held record carries an installation principal and derives its managed owner', () => {
  const record = decodeStoredDeviceClaim(allocatorClaim());
  expect(record).not.toBeNull();
  if (!record || !isAllocatorHeldDeviceClaim(record)) throw new Error('expected allocator-held');
  expect(record).toEqual({
    schemaVersion: 3,
    kind: 'allocator',
    deviceKey: DEVICE_KEY,
    device: { family: 'android', id: 'emulator-5554', name: 'Pixel', kind: 'emulator' },
    stateDir: '/state/host',
    allocator: { instanceId: 'sim-a', identityIncarnationId: 'inc-1' },
    createdAtMs: 1,
    updatedAtMs: 2,
  });
  // The owner is derived from the recorded instance, so it can never disagree with the principal.
  expect(allocatorHeldClaimOwner(record)).toEqual(managedLocalRuntimeOwner('sim-a'));
});

test('an allocator-held record carrying any process principal field is unreadable', () => {
  // The whole point of the separate kind: no clearing surface may find a process to match.
  for (const field of [
    { ownerPid: 4242 },
    { ownerStartTime: 'start' },
    { ownerToken: 'token' },
    { session: 'work' },
    { workspace: '/worktrees/x' },
    { abandonedAtMs: 5 },
  ]) {
    expect(decodeStoredDeviceClaim(allocatorClaim(field))).toBeNull();
  }
});

test('an allocator-held record needs its kind, its whole allocator principal, and its own device key', () => {
  expect(decodeStoredDeviceClaim(allocatorClaim({ kind: 'session' }))).toBeNull();
  expect(decodeStoredDeviceClaim(allocatorClaim({ kind: undefined }))).toBeNull();
  expect(
    decodeStoredDeviceClaim(allocatorClaim({ allocator: { instanceId: 'sim-a' } })),
  ).toBeNull();
  expect(
    decodeStoredDeviceClaim(
      allocatorClaim({ allocator: { instanceId: '', identityIncarnationId: 'inc-1' } }),
    ),
  ).toBeNull();
  // A padded id would fence one request while keying another managed owner.
  expect(
    decodeStoredDeviceClaim(
      allocatorClaim({ allocator: { instanceId: ' sim-a ', identityIncarnationId: 'inc-1' } }),
    ),
  ).toBeNull();
  expect(decodeStoredDeviceClaim(allocatorClaim({ stateDir: '' }))).toBeNull();
  expect(
    decodeStoredDeviceClaim(allocatorClaim({ deviceKey: 'local:android:none:other' })),
  ).toBeNull();
});

test('a record of an unknown schema version is unreadable', () => {
  expect(decodeStoredDeviceClaim(allocatorClaim({ schemaVersion: 4 }))).toBeNull();
  expect(decodeStoredDeviceClaim(currentClaim({ schemaVersion: 0 }))).toBeNull();
  expect(decodeStoredDeviceClaim(null)).toBeNull();
  expect(decodeStoredDeviceClaim([allocatorClaim()])).toBeNull();
});
