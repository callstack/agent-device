// privateGroupId: the one group shape the destination-ancestry rule admits, and what a name service
// does to that claim. Both are pure decisions over host account records, so they are judged here rather
// than through a filesystem.

import { expect, test } from 'vitest';
import { nameServiceListsOnlyFiles, privateGroupId } from './atomic-file.ts';

const ADA = { uid: 1000, gid: 1000, name: 'ada' };

const FILES = ['passwd: files', 'group: files'];

function database(groups: readonly string[] | undefined, passwd: readonly string[] | undefined) {
  return { groups, passwd, nsswitch: FILES };
}

const PRIVATE = ['ada:x:1000:', 'staff:x:20:root'];
const PRIVATE_PASSWD = ['ada:x:1000:1000:', 'root:x:0:0'];

test('admits the group named after the user, holding only them, as their primary group', () => {
  expect(privateGroupId(database(PRIVATE, PRIVATE_PASSWD), ADA)).toBe(1000);
});

test('admits root named among the members, the account the whole rule trusts', () => {
  expect(
    privateGroupId(database(['ada:x:1000:root'], ['ada:x:1000:1000:', 'root:x:0:0']), ADA),
  ).toBe(1000);
});

test('refuses a second group carrying the same gid when it lists another user', () => {
  // `ada:x:1000:` looks private on its own, and the group named after the user is the only one the
  // exception used to read. A directory group-writable by gid 1000 is writable by grace too, because
  // `team` carries the same number.
  expect(
    privateGroupId(
      database(
        ['ada:x:1000:', 'team:x:1000:grace'],
        ['ada:x:1000:1000:', 'grace:x:1001:1001:', 'root:x:0:0'],
      ),
      ADA,
    ),
  ).toBeUndefined();
});

test('admits a second group carrying the same gid when it reaches nobody else', () => {
  expect(
    privateGroupId(
      database(['ada:x:1000:', 'ada-alias:x:1000:'], ['ada:x:1000:1000:', 'root:x:0:0']),
      ADA,
    ),
  ).toBe(1000);
});

test('refuses it once a second group sharing the gid has another user as its primary group', () => {
  expect(
    privateGroupId(
      database(['ada:x:1000:', 'team:x:1000:'], ['ada:x:1000:1000:', 'grace:x:1001:1000:']),
      ADA,
    ),
  ).toBeUndefined();
});

test('refuses it once another user is a member', () => {
  expect(
    privateGroupId(
      database(['ada:x:1000:grace'], ['ada:x:1000:1000:', 'grace:x:1001:1001:', 'root:x:0:0']),
      ADA,
    ),
  ).toBeUndefined();
});

test('refuses it once another user has it as their primary group', () => {
  expect(
    privateGroupId(database(['ada:x:1000:'], ['ada:x:1000:1000:', 'grace:x:1001:1000:']), ADA),
  ).toBeUndefined();
});

test('refuses a group that is not the primary group of the user, however few members it lists', () => {
  expect(privateGroupId(database(['ada:x:4321:'], ['ada:x:1000:1000:']), ADA)).toBeUndefined();
});

test('refuses a group that does not carry the name of the user', () => {
  expect(privateGroupId(database(['team:x:1000:'], ['ada:x:1000:1000:']), ADA)).toBeUndefined();
});

test('refuses it when the group file cannot be read', () => {
  expect(privateGroupId(database(undefined, PRIVATE_PASSWD), ADA)).toBeUndefined();
});

test('refuses it when the passwd file cannot be read', () => {
  expect(privateGroupId(database(PRIVATE, undefined), ADA)).toBeUndefined();
});

test('refuses it when the user has no passwd record', () => {
  expect(privateGroupId(database(PRIVATE, ['root:x:0:0']), ADA)).toBeUndefined();
});

test('refuses it when the passwd record names another uid or gid', () => {
  const other = { uid: 1002, gid: 1000, name: 'ada' };
  expect(privateGroupId(database(PRIVATE, PRIVATE_PASSWD), other)).toBeUndefined();
});

test('refuses it when /etc/nsswitch.conf cannot be read', () => {
  expect(
    privateGroupId({ groups: PRIVATE, passwd: PRIVATE_PASSWD, nsswitch: undefined }, ADA),
  ).toBeUndefined();
});

test('refuses it when nsswitch.conf adds a name service to either database', () => {
  const withNameService = (databaseLines: string[]) =>
    privateGroupId({ groups: PRIVATE, passwd: PRIVATE_PASSWD, nsswitch: databaseLines }, ADA);

  expect(withNameService(['passwd: files ldap', 'group: files'])).toBeUndefined();
  expect(withNameService(['passwd: files', 'group: files sss'])).toBeUndefined();
  // `systemd` is the default on some distributions and is still refused: userdbd answers membership from
  // records these two files never show.
  expect(withNameService(['passwd: files systemd', 'group: files systemd'])).toBeUndefined();
  expect(withNameService(['passwd: files', 'group:'])).toBeUndefined();
  expect(withNameService(['# no database lines here'])).toBeUndefined();
});

test('admits a name service line that names only files, actions and comments aside', () => {
  expect(
    nameServiceListsOnlyFiles(['passwd: [NOTFOUND=return] files # local only', 'group:  files']),
  ).toBe(true);
  expect(nameServiceListsOnlyFiles(['passwd: files', 'group: files db'])).toBe(false);
  expect(nameServiceListsOnlyFiles(undefined)).toBe(false);
});

test('gives a caller without a full identity no private group', () => {
  const groups = database(PRIVATE, PRIVATE_PASSWD);
  expect(privateGroupId(groups, { uid: undefined, gid: 1000, name: 'ada' })).toBeUndefined();
  expect(privateGroupId(groups, { uid: 1000, gid: undefined, name: 'ada' })).toBeUndefined();
  expect(privateGroupId(groups, { uid: 1000, gid: 1000, name: undefined })).toBeUndefined();
});
