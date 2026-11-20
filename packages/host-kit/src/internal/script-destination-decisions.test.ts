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
} from './script-destination.ts';
/**
 * The decisions read only the ids they are handed, so the tables name fixed ones: an ordinary user, another
 * ordinary user, and root. No answer depends on the account that runs the suite.
 */
const USER_UID = 1000;
const FOREIGN_UID = 1001;

// --- what makes one directory unsafe to publish inside ---

const OWN = { uid: USER_UID, mode: 0o755 };
const TRUST = { uid: USER_UID };
const PRIVATE_TRUST = { uid: USER_UID, privateAncestry: true };
const PRIVATE_ROOT_TRUST = { uid: USER_UID, closedToOwnGroup: true };
const ROOT_TRUST = { uid: 0 };

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

test("accepts a group-writable directory this non-root user owns, whose group is its owner's to answer for", () => {
  // The shape every `mkdir` leaves under umask 002 (ADR 0016).
  expect(untrustedAncestryExposure(directoryOf({ mode: 0o775 }), TRUST)).toBeUndefined();
  expect(untrustedAncestryExposure(directoryOf({ mode: 0o2770 }), TRUST)).toBeUndefined();
});

test('refuses a group-writable directory root owns, whoever asks', () => {
  // No non-root owner answers for root's group, and a process running as root gets no exception.
  for (const mode of [0o775, 0o2770]) {
    expect(untrustedAncestryExposure(directoryOf({ uid: 0, mode }), TRUST)).toBe(
      'shared_group_writable',
    );
    expect(untrustedAncestryExposure(directoryOf({ uid: 0, mode }), ROOT_TRUST)).toBe(
      'shared_group_writable',
    );
  }
});

test('still refuses a world-writable directory this user owns that is also group-writable', () => {
  expect(untrustedAncestryExposure(directoryOf({ mode: 0o776 }), TRUST)).toBe('world_writable');
});

test('refuses a group-writable directory this user owns for executable state and a private root', () => {
  for (const mode of [0o775, 0o1775]) {
    expect(untrustedAncestryExposure(directoryOf({ mode }), PRIVATE_TRUST)).toBe(
      'shared_group_writable',
    );
  }
  expect(untrustedAncestryExposure(directoryOf({ mode: 0o775 }), PRIVATE_ROOT_TRUST)).toBe(
    'shared_group_writable',
  );
  expect(othersCreateEntriesIn(directoryOf({ mode: 0o775 }), PRIVATE_TRUST)).toBe(true);
  expect(othersCreateEntriesIn(directoryOf({ mode: 0o775 }), PRIVATE_ROOT_TRUST)).toBe(true);
  expect(
    untrustedLinkExposure({ uid: USER_UID }, directoryOf({ mode: 0o775 }), PRIVATE_TRUST),
  ).toBe('planted_link');
});

test("names a co-user's group-writable directory for whose it is, not for its mode", () => {
  expect(untrustedAncestryExposure(directoryOf({ uid: FOREIGN_UID, mode: 0o775 }), TRUST)).toBe(
    'foreign_owned',
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
  const link = { uid: USER_UID };
  expect(untrustedLinkExposure(link, directoryOf({ mode: 0o755 }), TRUST)).toBeUndefined();
  expect(untrustedLinkExposure(link, directoryOf({ uid: 0, mode: 0o755 }), TRUST)).toBeUndefined();
});

test('accepts a link held in a group-writable directory this user owns, whoever owns the link', () => {
  const own = directoryOf({ mode: 0o775 });
  expect(untrustedLinkExposure({ uid: USER_UID }, own, TRUST)).toBeUndefined();
  expect(untrustedLinkExposure({ uid: FOREIGN_UID }, own, TRUST)).toBeUndefined();
});

test('refuses a link in a group-writable directory root owns, which is ground others can write', () => {
  // The link's OWN owner is this user, and it is still refused: a member of root's group could have added the
  // name here first, and the destination would follow their link.
  const rootOwned = directoryOf({ uid: 0, mode: 0o775 });
  expect(untrustedLinkExposure({ uid: USER_UID }, rootOwned, TRUST)).toBe('planted_link');
});

test('refuses a link in a shared directory unless the sticky bit and its owner hold it in place', () => {
  expect(untrustedLinkExposure({ uid: USER_UID }, directoryOf({ mode: 0o777 }), TRUST)).toBe(
    'planted_link',
  );
  expect(untrustedLinkExposure({ uid: FOREIGN_UID }, directoryOf({ mode: 0o1777 }), TRUST)).toBe(
    'planted_link',
  );
});

test('accepts a link this user or root owns in a sticky shared directory', () => {
  const sticky = directoryOf({ mode: 0o1777 });
  expect(untrustedLinkExposure({ uid: USER_UID }, sticky, TRUST)).toBeUndefined();
  expect(untrustedLinkExposure({ uid: 0 }, sticky, TRUST)).toBeUndefined();
});

// --- othersCreateEntriesIn: where another local user could claim the entry ---

test('names a directory others can add entries in, sticky bit or no sticky bit', () => {
  expect(othersCreateEntriesIn(directoryOf({ mode: 0o777 }), TRUST)).toBe(true);
  expect(othersCreateEntriesIn(directoryOf({ mode: 0o1777 }), TRUST)).toBe(true);
  expect(othersCreateEntriesIn(directoryOf({ uid: 0, mode: 0o775 }), TRUST)).toBe(true);
  expect(othersCreateEntriesIn(directoryOf({ uid: 0, mode: 0o775 }), ROOT_TRUST)).toBe(true);
});

test('names no group-writable directory this user owns, sticky or not, unless it is world-writable', () => {
  expect(othersCreateEntriesIn(directoryOf({ mode: 0o775 }), TRUST)).toBe(false);
  expect(othersCreateEntriesIn(directoryOf({ mode: 0o1770 }), TRUST)).toBe(false);
  expect(othersCreateEntriesIn(directoryOf({ mode: 0o776 }), TRUST)).toBe(true);
});

test('names no directory that keeps its contents closed to the group', () => {
  expect(othersCreateEntriesIn(directoryOf({ mode: 0o755 }), TRUST)).toBe(false);
  expect(othersCreateEntriesIn(directoryOf({ mode: 0o1755 }), TRUST)).toBe(false);
  expect(othersCreateEntriesIn(directoryOf({ mode: 0o750 }), TRUST)).toBe(false);
});

test('names a directory another user owns, whatever its mode', () => {
  expect(othersCreateEntriesIn(directoryOf({ uid: FOREIGN_UID, mode: 0o755 }), TRUST)).toBe(true);
  expect(othersCreateEntriesIn(directoryOf({ uid: FOREIGN_UID, mode: 0o1777 }), TRUST)).toBe(true);
});

test('names no directory this user or root owns that others cannot write', () => {
  expect(othersCreateEntriesIn(directoryOf({ uid: 0, mode: 0o755 }), TRUST)).toBe(false);
  expect(othersCreateEntriesIn(directoryOf({ uid: 0, mode: 0o1777 }), TRUST)).toBe(true);
});
