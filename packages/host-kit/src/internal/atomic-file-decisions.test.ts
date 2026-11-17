// The three decisions the destination-ancestry rule makes about ground it has already found: whether a
// directory is safe to publish inside, which link on the path belongs to somebody else, and where another
// local user could claim the entry. Each is a judgment over the fields of one `lstat`, so they are judged
// here on their values rather than through a filesystem.

import { expect, test } from 'vitest';
import {
  othersCreateEntriesIn,
  untrustedAncestryExposure,
  untrustedLinkExposure,
  type DirectoryAuthority,
} from './atomic-file.ts';
import { FOREIGN_UID, currentUid } from './atomic-file-host.fixtures.ts';

// --- what makes one directory unsafe to publish inside ---

const OWN = { uid: currentUid, mode: 0o755 };
const TRUST = { uid: currentUid };

function directoryOf(overrides: Partial<DirectoryAuthority>): DirectoryAuthority {
  return { ...OWN, ...overrides };
}

test('refuses a directory another user owns, whatever its mode', () => {
  expect(untrustedAncestryExposure(directoryOf({ uid: FOREIGN_UID, mode: 0o700 }), TRUST)).toBe(
    'foreign_owned',
  );
  expect(untrustedAncestryExposure(directoryOf({ uid: FOREIGN_UID, mode: 0o755 }), TRUST)).toBe(
    'foreign_owned',
  );
});

test('refuses a directory that is world-writable', () => {
  expect(untrustedAncestryExposure(directoryOf({ mode: 0o777 }), TRUST)).toBe('world_writable');
});

test('refuses a directory that is group-writable, whoever owns the group', () => {
  // ADR 0016 carries no private-group exception: proving a group holds no other user means reading the
  // host's account files, which cannot be settled on a host whose name service answers membership from
  // somewhere else. The mode alone decides, which is why the rule does not read a `gid` at all.
  expect(untrustedAncestryExposure(directoryOf({ mode: 0o775 }), TRUST)).toBe(
    'shared_group_writable',
  );
  expect(untrustedAncestryExposure(directoryOf({ uid: 0, mode: 0o2770 }), TRUST)).toBe(
    'shared_group_writable',
  );
});

test('accepts a root-owned directory and a directory this user owns', () => {
  expect(untrustedAncestryExposure(directoryOf({ uid: 0 }), TRUST)).toBeUndefined();
  expect(untrustedAncestryExposure(directoryOf({}), TRUST)).toBeUndefined();
});

test('accepts a sticky directory this user or root owns for passing through', () => {
  expect(untrustedAncestryExposure(directoryOf({ uid: 0, mode: 0o1777 }), TRUST)).toBeUndefined();
  expect(untrustedAncestryExposure(directoryOf({ mode: 0o1777 }), TRUST)).toBeUndefined();
});

test('refuses a sticky directory another user owns, since both bits shield others FROM that owner', () => {
  expect(untrustedAncestryExposure(directoryOf({ uid: FOREIGN_UID, mode: 0o1777 }), TRUST)).toBe(
    'foreign_owned',
  );
  expect(untrustedAncestryExposure(directoryOf({ uid: FOREIGN_UID, mode: 0o2775 }), TRUST)).toBe(
    'foreign_owned',
  );
});

// --- untrustedLinkExposure: which link on the path belongs to somebody else ---

test('accepts a link in a directory only this user or root can add entries to', () => {
  const link = { uid: currentUid };
  expect(untrustedLinkExposure(link, directoryOf({ mode: 0o755 }), TRUST)).toBeUndefined();
  expect(untrustedLinkExposure(link, directoryOf({ uid: 0, mode: 0o755 }), TRUST)).toBeUndefined();
});

test('refuses a link in a group-writable directory, which is ground others can write', () => {
  expect(untrustedLinkExposure({ uid: currentUid }, directoryOf({ mode: 0o775 }), TRUST)).toBe(
    'planted_link',
  );
});

test('refuses a link in a shared directory unless the sticky bit and its owner hold it in place', () => {
  expect(untrustedLinkExposure({ uid: currentUid }, directoryOf({ mode: 0o777 }), TRUST)).toBe(
    'planted_link',
  );
  expect(untrustedLinkExposure({ uid: FOREIGN_UID }, directoryOf({ mode: 0o1777 }), TRUST)).toBe(
    'planted_link',
  );
});

test('accepts a link this user or root owns in a sticky shared directory', () => {
  const sticky = directoryOf({ mode: 0o1777 });
  expect(untrustedLinkExposure({ uid: currentUid }, sticky, TRUST)).toBeUndefined();
  expect(untrustedLinkExposure({ uid: 0 }, sticky, TRUST)).toBeUndefined();
});

// --- othersCreateEntriesIn: where another local user could claim the entry ---

test('names a directory others can add entries in, sticky bit or no sticky bit', () => {
  expect(othersCreateEntriesIn(directoryOf({ mode: 0o777 }), TRUST)).toBe(true);
  expect(othersCreateEntriesIn(directoryOf({ mode: 0o1777 }), TRUST)).toBe(true);
  expect(othersCreateEntriesIn(directoryOf({ mode: 0o775 }), TRUST)).toBe(true);
});

test('names no directory that keeps its contents closed to the group', () => {
  expect(othersCreateEntriesIn(directoryOf({ mode: 0o755 }), TRUST)).toBe(false);
  expect(othersCreateEntriesIn(directoryOf({ mode: 0o1755 }), TRUST)).toBe(false);
});

test('names a directory another user owns, whatever its mode', () => {
  expect(othersCreateEntriesIn(directoryOf({ uid: FOREIGN_UID, mode: 0o755 }), TRUST)).toBe(true);
  expect(othersCreateEntriesIn(directoryOf({ uid: FOREIGN_UID, mode: 0o1777 }), TRUST)).toBe(true);
});

test('names no directory this user or root owns that others cannot write', () => {
  expect(othersCreateEntriesIn(directoryOf({ uid: 0, mode: 0o755 }), TRUST)).toBe(false);
  expect(othersCreateEntriesIn(directoryOf({ uid: 0, mode: 0o1777 }), TRUST)).toBe(true);
});
