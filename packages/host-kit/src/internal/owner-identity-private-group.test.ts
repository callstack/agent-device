// Whether a group-writable directory is safe because its group holds no other user, judged over account
// records the test supplies. The rule reads three host files, so each case states the records it changes and
// leaves the trusted shape alone everywhere else: a refusal has to be caused by the records named in the case.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { afterEach, test, vi } from 'vitest';
import {
  PRIVATE_GROUP_HOST_FILES,
  privateGroupOwned,
  type GroupMembership,
  type PrivateGroupHost,
} from './owner-identity.ts';

const skipOnWindows = process.platform === 'win32' ? test.skip : test;

const USER_UID = 1000;
const USER_GID = 1000;

/** The directory every case judges: this user owns it, and its group is their own. */
const DIRECTORY: GroupMembership = { gid: USER_GID, uid: USER_UID };

/** The name service a stock Ubuntu or Debian install writes, with no `initgroups` line at all. */
const TRUSTED_NSSWITCH = 'passwd: files systemd\ngroup: files systemd\n';

/** One user, one primary group numbered like them: the shape an installer writes. */
const OWN_ACCOUNT = 'me:x:1000:1000:Me,,,:/home/me:/bin/bash\n';

/** That user's group, listing nobody. The installer's own line. */
const OWN_GROUP = 'me:x:1000:\n';

afterEach(() => {
  vi.restoreAllMocks();
});

/** One host file's contents. `undefined` stands for a file the host will not open. */
type HostFiles = Partial<Record<keyof typeof PRIVATE_GROUP_HOST_FILES, string>>;

/**
 * A host whose three account files hold `overrides` over the trusted shape above, and whose kernel answers
 * `uid`. A file a test sets to `undefined` is one the host will not open, which is NOT an empty file.
 */
function host(
  overrides: HostFiles,
  uid: () => number | undefined = () => USER_UID,
): PrivateGroupHost {
  const contents = new Map<string, string | undefined>([
    [PRIVATE_GROUP_HOST_FILES.nsswitch, TRUSTED_NSSWITCH],
    [PRIVATE_GROUP_HOST_FILES.passwd, OWN_ACCOUNT],
    [PRIVATE_GROUP_HOST_FILES.group, OWN_GROUP],
  ]);
  for (const [name, text] of Object.entries(overrides) as Array<
    [keyof typeof PRIVATE_GROUP_HOST_FILES, string | undefined]
  >) {
    contents.set(PRIVATE_GROUP_HOST_FILES[name], text);
  }
  return { read: (path) => contents.get(path), uid };
}

/** The verdict for `directory` over `overrides`. */
function verdict(overrides: HostFiles = {}, directory: GroupMembership = DIRECTORY): boolean {
  return privateGroupOwned(directory, host(overrides));
}

test('accepts the per-user group shape a stock Ubuntu install creates', () => {
  // `passwd: files systemd` and `group: files systemd` with NO `initgroups` line, so the group answer is the
  // whole story for supplementary groups too. `me:x:1000:` lists no member, and no other record carries gid
  // 1000 or names `me` in a group at all.
  assert.equal(privateGroupOwned(DIRECTORY, host({})), true);
});

test('accepts a present initgroups line that names only local sources', () => {
  assert.equal(
    verdict({
      nsswitch: 'passwd: files systemd\ngroup: files systemd\ninitgroups: files systemd\n',
    }),
    true,
  );
});

test('refuses a present initgroups line that names a directory service, though group is trusted', () => {
  // The inherited and the stated cases are separate readings: an absent `initgroups` inherits the trusted
  // `group` sources, so this line being trusted is what a lookup would consult. glibc's `initgroups` source
  // decides which groups a process holds, and a directory service can hand this gid to another user.
  assert.equal(
    verdict({ nsswitch: 'passwd: files\ngroup: files\ninitgroups: ldap\n' }),
    false,
    'an untrusted initgroups line is refused while group stays trusted',
  );
  // The same file without that line inherits `group`, and is accepted.
  assert.equal(verdict({ nsswitch: 'passwd: files\ngroup: files\n' }), true);
});

test('refuses a name-service file that states the group database twice', () => {
  // The second line is the one glibc keeps, so a reader that kept the first would accept a gid the real
  // lookup resolves through `sss`. Neither reading is the one to trust, so the file is refused outright.
  assert.equal(verdict({ nsswitch: 'passwd: files\ngroup: files\ngroup: files sss\n' }), false);
});

test('refuses a name-service file that states the passwd database twice', () => {
  assert.equal(verdict({ nsswitch: 'passwd: files\npasswd: files sss\ngroup: files\n' }), false);
});

test('refuses a name-service file that states initgroups twice', () => {
  assert.equal(
    verdict({ nsswitch: 'passwd: files\ngroup: files\ninitgroups: files\ninitgroups: sss\n' }),
    false,
  );
});

test('refuses a group database served from a directory service as well as from files', () => {
  assert.equal(verdict({ nsswitch: 'passwd: files\ngroup: files ldap\n' }), false);
});

test('refuses a passwd database served from a daemon as well as from files', () => {
  // `sss` answers accounts the local file never shows, so the account list read here is not the whole story.
  assert.equal(verdict({ nsswitch: 'passwd: sss files\ngroup: files\n' }), false);
});

test('refuses every other name service, and a database with no source at all', () => {
  for (const source of ['nis', 'nisplus', 'db', 'compat', 'myhostname', 'resolve', 'dns', 'ldap']) {
    assert.equal(verdict({ nsswitch: `passwd: files\ngroup: files ${source}\n` }), false, source);
  }
  // An empty source list names a database no lookup reads, which is not the same as a local-only one.
  assert.equal(verdict({ nsswitch: 'passwd: files\ngroup:\n' }), false);
  assert.equal(verdict({ nsswitch: 'passwd:\ngroup: files\n' }), false);
});

test('refuses a name-service file the host has none of, and one it will not open', () => {
  assert.equal(verdict({ nsswitch: undefined }), false);
  // An unreadable file is a host that refuses the read, which is a different answer from an empty file.
  assert.equal(
    privateGroupOwned(DIRECTORY, {
      read: (path) => {
        if (path === PRIVATE_GROUP_HOST_FILES.nsswitch) throw new Error('EACCES');
        if (path === PRIVATE_GROUP_HOST_FILES.passwd) return OWN_ACCOUNT;
        return OWN_GROUP;
      },
      uid: () => USER_UID,
    }),
    false,
  );
});

test('refuses a bracketed lookup action instead of ignoring it', () => {
  // Whether `[NOTFOUND=return]` ends a lookup before a later source answers is a reading no local file
  // settles, so a clause that steers a lookup is refused rather than given the benefit of the doubt.
  assert.equal(
    verdict({ nsswitch: 'passwd: files\ngroup: files [NOTFOUND=return] systemd\n' }),
    false,
  );
  assert.equal(verdict({ nsswitch: 'passwd: files [SUCCESS=return]\ngroup: files\n' }), false);
});

test('refuses a second group record for the gid that lists another user', () => {
  // A directory writable by gid 1000 is writable by the members of EVERY group holding that number,
  // however it is named, so `bob` reaches this directory through `team`.
  assert.equal(verdict({ group: 'me:x:1000:\nteam:x:1000:me,bob\n' }), false);
  // The other direction of the same rule: a second record that lists nobody but this user claims nothing.
  assert.equal(verdict({ group: 'me:x:1000:\nteam:x:1000:me\n' }), true);
});

test('refuses a group that lists another member', () => {
  assert.equal(verdict({ group: 'me:x:1000:bob\n' }), false);
});

test('refuses a gid no group record carries', () => {
  // The passwd file names a group the group file never shows, so nothing read here says who belongs to it.
  assert.equal(verdict({ group: 'staff:x:20:me\n' }), false);
});

test('refuses another account whose primary group is this gid', () => {
  // `svc` holds gid 1000 with no mention in the group database, and writes as this directory's group.
  assert.equal(
    verdict({
      passwd: `${OWN_ACCOUNT}svc:x:1001:1000:Service,,,:/nonexistent:/usr/sbin/nologin\n`,
    }),
    false,
  );
  // An account with its OWN primary group is nobody's claim on this directory.
  assert.equal(
    verdict({
      passwd: `${OWN_ACCOUNT}svc:x:1001:1001:Service,,,:/nonexistent:/usr/sbin/nologin\n`,
    }),
    true,
  );
});

test('refuses a directory another user owns', () => {
  // The owner chooses a directory's group, so this answer would be about a group they can change at will.
  assert.equal(verdict({}, { uid: 1001, gid: USER_GID }), false);
});

test('refuses a directory whose group is not this account primary group', () => {
  // `staff` lists only `me`, so membership alone would pass. The primary-gid rule is what refuses: the
  // process gid is not asked, because a process can hold a group its own account does not.
  assert.equal(
    verdict({ group: 'me:x:1000:\nstaff:x:20:me\n' }, { uid: USER_UID, gid: 20 }),
    false,
  );
});

test('refuses an account database that cannot say whose account is whose', () => {
  assert.equal(
    privateGroupOwned(
      DIRECTORY,
      host({}, () => undefined),
    ),
    false,
    'no uid from the host',
  );
  // An empty database holds no record to prove this group private.
  assert.equal(verdict({ passwd: '' }), false);
  // A line with too few fields leaves this user's primary gid unread.
  assert.equal(verdict({ passwd: 'me:x:1000\n' }), false);
  // Two records for one uid leave the primary gid ambiguous.
  assert.equal(
    verdict({ passwd: `${OWN_ACCOUNT}me2:x:1000:1001:Me two,,,:/home/me:/bin/sh\n` }),
    false,
  );
});

test('refuses a group database the host will not open', () => {
  assert.equal(verdict({ group: undefined }), false);
  assert.equal(verdict({ group: '' }), false, 'an empty group file proves nothing');
  assert.equal(verdict({ group: 'me:x:notanumber:\n' }), false);
});

test('reads the name-service keys as whole words at the line start, past comments and blank lines', () => {
  // `# group: ldap` is a comment, so it is not a `group` line and it does not duplicate anything. Indentation
  // and a tab before a key are spacing, and a trailing comment is not a source.
  const nsswitch = [
    '',
    '# /etc/nsswitch.conf',
    '# group: ldap',
    '\n',
    '   passwd: files\t# accounts come from the file',
    '\t#passwd: sss',
    '',
    '\tgroup:  files\tsystemd\t# a tab and extra spacing',
    'shadow: files sss',
    '#initgroups: ldap',
    '  ',
  ].join('\n');
  assert.equal(verdict({ nsswitch }), true);
});

skipOnWindows('reads the three system files by name when the host is not injected', () => {
  // The default host is the real one: it must ask for `/etc/passwd`, `/etc/group`, and
  // `/etc/nsswitch.conf`, and take this process's uid from the kernel. Records keyed to the real uid and gid
  // make the verdict depend on all three reads and on that uid.
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  assert.ok(uid !== undefined && gid !== undefined, 'the host reports no identity');
  const files = new Map<string, string>([
    [PRIVATE_GROUP_HOST_FILES.nsswitch, 'passwd: files\ngroup: files\n'],
    [PRIVATE_GROUP_HOST_FILES.passwd, `me:x:${uid}:${gid}:Me,,,:/home/me:/bin/bash\n`],
    [PRIVATE_GROUP_HOST_FILES.group, `me:x:${gid}:\n`],
  ]);
  const reads = vi.spyOn(fs, 'readFileSync');
  reads.mockImplementation(((target: fs.PathOrFileDescriptor) =>
    typeof target === 'string' ? (files.get(target) ?? '') : '') as typeof fs.readFileSync);

  assert.equal(privateGroupOwned({ uid, gid }), true);
  assert.deepEqual(
    [...new Set(reads.mock.calls.map(([target]) => String(target)))].sort(),
    [...files.keys()].sort(),
  );
});
