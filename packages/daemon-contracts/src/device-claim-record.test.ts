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
    expect(record.transientCommand).toBeUndefined();
  }
});

// Released v1/v2 recorded a command-scoped claim and an open session *named* `transient:<command>`
// as the same record — no stored field separates them, so the kind of a legacy claim is not a
// fact the decoder can read. Both decode kindless, which is safe by construction, not by guess:
// the kind is consulted only for claims `isClaimOwnedByThisDaemon` accepts (same stateDir, pid,
// and process start time), and a live process reads and writes only v3 records, whose kind is a
// stored field. No in-flight command's claim is ever a legacy record; the original #3345 bypass
// needs a current-process claim, which carries its kind.
test('a legacy claim with a command-label session decodes kindless, not as a guessed command claim', () => {
  for (const raw of [
    legacyClaim({ session: 'transient:install' }),
    v2Claim({ session: 'transient:install' }),
  ]) {
    const record = decodeStoredDeviceClaim(raw);
    expect(record?.transientCommand).toBeUndefined();
    expect(record?.session).toBe('transient:install');
  }
});

// The kind is a stored field from v3 on. A v3 open session may be named after a command, and a
// v3 record without the field is exactly that session's claim; a malformed kind fails the record
// closed instead of guessing.
test('a v3 claim kind comes only from its stored field', () => {
  expect(
    decodeStoredDeviceClaim(currentClaim({ session: 'transient:install' }))?.transientCommand,
  ).toBeUndefined();
  expect(
    decodeStoredDeviceClaim(currentClaim({ transientCommand: 'install' }))?.transientCommand,
  ).toBe('install');
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
