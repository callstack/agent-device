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
  return {
    ...v2Claim(),
    schemaVersion: 3,
    claimOwnerKind: 'open-session',
    ...overrides,
  };
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
// as the same record, so no stored field can say which one a legacy record was. Such a record
// still decodes — clearing, reconciliation, and stale settlement need its principal — but it
// states no kind, so a migrated record can never cover a command.
test('a migrated record normalizes to the current schema and states no claim kind', () => {
  for (const raw of [
    legacyClaim({ session: 'transient:install' }),
    v2Claim({ session: 'transient:install' }),
  ]) {
    const record = decodeStoredDeviceClaim(raw);
    expect(record).not.toBeNull();
    if (!record) throw new Error('expected a decoded claim');
    expect(record.schemaVersion).toBe(3);
    expect(record.session).toBe('transient:install');
    expect(record.claimOwnerKind).toBe('unstated');
    expect(record.transientCommand).toBeUndefined();
  }
});

// A current record states its kind, and the kind fields have to agree. An open session may
// legitimately be named after a command; a malformed kind fails the record closed.
test('a current-version claim kind comes only from its stored fields', () => {
  const named = decodeStoredDeviceClaim(currentClaim({ session: 'transient:install' }));
  expect(named).not.toBeNull();
  if (!named) throw new Error('expected a decoded claim');
  expect(named.claimOwnerKind).toBe('open-session');
  expect(named.transientCommand).toBeUndefined();

  const scoped = decodeStoredDeviceClaim(
    currentClaim({ claimOwnerKind: 'transient-command', transientCommand: 'install' }),
  );
  expect(scoped).not.toBeNull();
  if (!scoped) throw new Error('expected a decoded claim');
  expect(scoped.claimOwnerKind).toBe('transient-command');
  expect(scoped.transientCommand).toBe('install');

  expect(decodeStoredDeviceClaim(currentClaim({ transientCommand: 'install' }))).toBeNull();
  expect(
    decodeStoredDeviceClaim(
      currentClaim({ claimOwnerKind: 'transient-command', transientCommand: '' }),
    ),
  ).toBeNull();
  expect(decodeStoredDeviceClaim(currentClaim({ claimOwnerKind: 'bogus' }))).toBeNull();
});

test('a record of an unknown schema version is unreadable', () => {
  // A future-schema record carrying a whole process principal is still not migrated into a claim.
  for (const schemaVersion of [0, 4, 5]) {
    expect(decodeStoredDeviceClaim(currentClaim({ schemaVersion }))).toBeNull();
  }
  expect(decodeStoredDeviceClaim(null)).toBeNull();
  expect(decodeStoredDeviceClaim([currentClaim()])).toBeNull();
});
