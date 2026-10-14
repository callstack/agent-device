import { expect, test } from 'vitest';
import { decodeStoredDeviceClaim } from '../device-claim-record.ts';

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

test('v1 and v2 records decode to the process-owned claim with its process principal intact', () => {
  for (const raw of [legacyClaim(), currentClaim()]) {
    const record = decodeStoredDeviceClaim(raw);
    expect(record).not.toBeNull();
    if (!record) throw new Error('expected process-owned');
    expect(record.schemaVersion).toBe(2);
    expect(record.session).toBe('work');
    expect(record.ownerPid).toBe(4242);
    expect(record.ownerToken).toBe('token');
  }
  expect(
    decodeStoredDeviceClaim(legacyClaim({ session: 'transient:install' }))?.schemaVersion,
  ).toBe(2);
});

test('a record of an unknown schema version is unreadable', () => {
  // A future-schema record carrying a whole process principal is still not migrated into a claim.
  for (const schemaVersion of [0, 3, 4]) {
    expect(decodeStoredDeviceClaim(currentClaim({ schemaVersion }))).toBeNull();
  }
  expect(decodeStoredDeviceClaim(null)).toBeNull();
  expect(decodeStoredDeviceClaim([currentClaim()])).toBeNull();
});
