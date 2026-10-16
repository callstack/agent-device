import { expect, test } from 'vitest';
import { decodeStoredDeviceClaim } from './device-claim-record.ts';

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

function v2Claim(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...legacyClaim(),
    schemaVersion: 2,
    device: { family: 'android', id: 'emulator-5554', name: 'Pixel', kind: 'emulator' },
    ...overrides,
  };
}

function currentClaim(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...v2Claim(), schemaVersion: 3, ...overrides };
}

test('v1, v2, and v3 records decode to the process-owned claim with its process principal intact', () => {
  for (const raw of [legacyClaim(), v2Claim(), currentClaim()]) {
    const record = decodeStoredDeviceClaim(raw);
    expect(record).not.toBeNull();
    if (!record) throw new Error('expected process-owned');
    expect(record.schemaVersion).toBe(3);
    expect(record.session).toBe('work');
    expect(record.ownerPid).toBe(4242);
    expect(record.ownerToken).toBe('token');
  }
});

test('a legacy claim claim-kind comes from the label that encoded it, once at the boundary', () => {
  // The pre-kind schemas recorded a command-scoped claim only as a `transient:<command>` session.
  for (const raw of [
    legacyClaim({ session: 'transient:install' }),
    v2Claim({ session: 'transient:reinstall' }),
  ]) {
    expect(decodeStoredDeviceClaim(raw)?.transientCommand).toBe(
      raw.session === 'transient:install' ? 'install' : 'reinstall',
    );
  }
  // From v3 the kind is a stored field, not a label pattern: a v3 open session may be named
  // after a command, and a v3 record without the field is that session's claim.
  expect(
    decodeStoredDeviceClaim(currentClaim({ session: 'transient:install' }))?.transientCommand,
  ).toBeUndefined();
  expect(
    decodeStoredDeviceClaim(currentClaim({ transientCommand: 'install' }))?.transientCommand,
  ).toBe('install');
  // A malformed kind fails the record closed instead of guessing a kind.
  expect(decodeStoredDeviceClaim(currentClaim({ transientCommand: '' }))).toBeNull();
  expect(decodeStoredDeviceClaim(currentClaim({ transientCommand: 7 }))).toBeNull();
});

test('a record of an unknown schema version is unreadable', () => {
  // A future-schema record carrying a whole process principal is still not migrated into a claim.
  for (const schemaVersion of [0, 4, 5]) {
    expect(decodeStoredDeviceClaim(currentClaim({ schemaVersion }))).toBeNull();
  }
  expect(decodeStoredDeviceClaim(null)).toBeNull();
  expect(decodeStoredDeviceClaim([currentClaim()])).toBeNull();
});
