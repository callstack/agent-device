import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, test } from 'vitest';
import {
  isSupersededDaemonOwner,
  readRegisteredDaemonIdentity,
  readRegisteredDaemonOwnership,
} from './daemon-registration.ts';
import {
  LIFETIME_TOKEN,
  LEGACY_RAW_START_TIME,
  STALE_LIFETIME_TOKEN,
  mkdtempForTestSync,
  publishDaemonRegistration,
} from '@agent-device/test-kit';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function useStateDir(): string {
  const root = mkdtempForTestSync('agent-device-daemon-registration-');
  roots.push(root);
  return root;
}

function infoPathOf(stateDir: string): string {
  return path.join(stateDir, 'daemon.json');
}

test('reads back the identity a running daemon publishes for its state dir', () => {
  const stateDir = useStateDir();
  publishDaemonRegistration(stateDir, { pid: process.pid, startTime: 'published-start' });

  assert.deepEqual(readRegisteredDaemonIdentity(infoPathOf(stateDir)), {
    pid: process.pid,
    startTime: 'published-start',
  });
});

test('reads no identity from an absent, corrupt, or pid-less registration', () => {
  const stateDir = useStateDir();
  assert.equal(readRegisteredDaemonIdentity(infoPathOf(stateDir)), null);

  fs.writeFileSync(infoPathOf(stateDir), '{not json');
  assert.equal(readRegisteredDaemonIdentity(infoPathOf(stateDir)), null);

  for (const pid of [0, -1, 1.5, '7', null]) {
    fs.writeFileSync(infoPathOf(stateDir), JSON.stringify({ pid, token: 'token' }));
    assert.equal(readRegisteredDaemonIdentity(infoPathOf(stateDir)), null);
  }
});

test('a different published pid proves the owner no longer serves its state dir', () => {
  const stateDir = useStateDir();
  publishDaemonRegistration(stateDir, { pid: 4242, startTime: 'successor-start' });

  assert.equal(isSupersededDaemonOwner({ stateDir, pid: 4141, startTime: 'owner-start' }), true);
});

test('a published start time proves supersession only when both sides are provenanced', () => {
  const stateDir = useStateDir();
  // Two `posix:` tokens with different values are the same provenanced format, so the difference
  // proves the pid changed hands.
  publishDaemonRegistration(stateDir, { pid: 4242, startTime: 'posix:1763493001000' });
  assert.equal(
    isSupersededDaemonOwner({ stateDir, pid: 4242, startTime: 'posix:1763493000000' }),
    true,
  );
  // Raw historical renderings — a localized one, and even the C form — are unqualified, so they
  // are unverified, never a proved supersession.
  assert.equal(
    isSupersededDaemonOwner({ stateDir, pid: 4242, startTime: 'mar. 17 nov. 19:42:28 2026' }),
    false,
  );
  assert.equal(
    isSupersededDaemonOwner({ stateDir, pid: 4242, startTime: 'Tue Nov 17 19:42:27 2026' }),
    false,
  );
  // An unreadable start time on either side leaves the identity unproven.
  assert.equal(isSupersededDaemonOwner({ stateDir, pid: 4242, startTime: null }), false);
  publishDaemonRegistration(stateDir, { pid: 4242, startTime: null });
  assert.equal(
    isSupersededDaemonOwner({ stateDir, pid: 4242, startTime: 'posix:1763493000000' }),
    false,
  );
});

test('a new-build record keeps the legacy raw field released clients read, beside the canonical token', () => {
  const stateDir = useStateDir();
  fs.writeFileSync(
    infoPathOf(stateDir),
    JSON.stringify({
      pid: 4242,
      processStartTime: LEGACY_RAW_START_TIME,
      processStartTimeToken: LIFETIME_TOKEN,
    }),
  );

  const record = JSON.parse(fs.readFileSync(infoPathOf(stateDir), 'utf8')) as Record<
    string,
    unknown
  >;
  // An old hardened client reads `processStartTime` and compares it with its own raw read: the
  // raw legacy value is still there, in the format it expects, so no spurious reclaim.
  assert.equal(record.processStartTime, LEGACY_RAW_START_TIME);
  assert.equal(record.processStartTimeToken, LIFETIME_TOKEN);

  const identity = readRegisteredDaemonIdentity(infoPathOf(stateDir));
  assert.equal(identity?.startTime, LIFETIME_TOKEN);

  // A new reader compares canonical tokens: the live owner matches, a stale one is proven replaced.
  assert.equal(
    isSupersededDaemonOwner({
      stateDir,
      pid: 4242,
      startTime: LIFETIME_TOKEN,
    }),
    false,
  );
  assert.equal(
    isSupersededDaemonOwner({
      stateDir,
      pid: 4242,
      startTime: STALE_LIFETIME_TOKEN,
    }),
    true,
  );
});

test('an old-format record (raw only) is unknown to new readers, never treated as replaced', () => {
  const stateDir = useStateDir();
  publishDaemonRegistration(stateDir, { pid: 4242, startTime: LEGACY_RAW_START_TIME });

  const identity = readRegisteredDaemonIdentity(infoPathOf(stateDir));
  assert.equal(identity?.startTime, LEGACY_RAW_START_TIME);
  // Raw record vs canonical live read: unknown, so not superseded — unresolved, not reassignment.
  assert.equal(
    isSupersededDaemonOwner({
      stateDir,
      pid: 4242,
      startTime: LIFETIME_TOKEN,
    }),
    false,
  );
  assert.equal(
    readRegisteredDaemonOwnership(infoPathOf(stateDir), {
      pid: 4242,
      startTime: LIFETIME_TOKEN,
    }).state,
    'unproven',
  );
});

test('the published owner itself is never superseded, and absence is not proof', () => {
  const stateDir = useStateDir();
  publishDaemonRegistration(stateDir, { pid: 4242, startTime: 'owner-start' });
  assert.equal(isSupersededDaemonOwner({ stateDir, pid: 4242, startTime: 'owner-start' }), false);

  fs.rmSync(infoPathOf(stateDir));
  assert.equal(isSupersededDaemonOwner({ stateDir, pid: 4242, startTime: 'owner-start' }), false);
});

test('the reading process is never superseded by a registration naming someone else', () => {
  const stateDir = useStateDir();
  publishDaemonRegistration(stateDir, { pid: 4242, startTime: 'successor-start' });

  assert.equal(isSupersededDaemonOwner({ stateDir, pid: process.pid, startTime: 'ours' }), false);
});

test('ownership is decided by the identity in the record, not by its pid alone', () => {
  const stateDir = useStateDir();
  const infoPath = infoPathOf(stateDir);
  const owner = { pid: process.pid, startTime: 'ours' };

  publishDaemonRegistration(stateDir, owner);
  assert.deepEqual(readRegisteredDaemonOwnership(infoPath, owner), { state: 'match' });

  // Two unreadable start times agree, and agreeing on nothing is not proof of ownership. Nor is this
  // a proved takeover, so it lands between the two rather than defaulting either way.
  publishDaemonRegistration(stateDir, { pid: process.pid, startTime: null });
  assert.deepEqual(readRegisteredDaemonOwnership(infoPath, { pid: process.pid, startTime: null }), {
    state: 'unproven',
  });

  // Same pid with a readable start time on the record but not on this side is still unproven: the
  // proof of a recycle has to run on two readable birth times, and `ownerIdentityDiffers` is one-way
  // by design so no caller mistakes one owner for two.
  publishDaemonRegistration(stateDir, { pid: process.pid, startTime: 'recycled' });
  assert.deepEqual(readRegisteredDaemonOwnership(infoPath, { pid: process.pid, startTime: null }), {
    state: 'unproven',
  });

  publishDaemonRegistration(stateDir, { pid: 4242, startTime: 'successor-start' });
  assert.deepEqual(readRegisteredDaemonOwnership(infoPath, owner), {
    state: 'replaced',
    identity: {
      pid: 4242,
      startTime: 'successor-start',
    },
  });
});

test('ownership names each way a record yields no owner', () => {
  const stateDir = useStateDir();
  const infoPath = infoPathOf(stateDir);
  const owner = { pid: process.pid, startTime: 'ours' };

  assert.deepEqual(readRegisteredDaemonOwnership(infoPath, owner), { state: 'absent' });

  fs.writeFileSync(infoPath, '{not json');
  assert.deepEqual(readRegisteredDaemonOwnership(infoPath, owner), { state: 'ownerless' });

  fs.writeFileSync(infoPath, JSON.stringify({ pid: 4242 }));
  assert.deepEqual(readRegisteredDaemonOwnership(infoPath, owner), {
    state: 'replaced',
    identity: { pid: 4242, startTime: null },
  });
});

test.skipIf(process.getuid?.() === 0)(
  'a registration this process cannot read is unreadable, not absent',
  () => {
    // EACCES leaves the file on disk: only a root-owned CI host reads mode 000 anyway, and reading it
    // there — or reading the failure as absence — would repeat #3087 from the other side.
    const infoPath = infoPathOf(useStateDir());
    fs.writeFileSync(infoPath, JSON.stringify({ pid: process.pid, processStartTime: 'ours' }));
    fs.chmodSync(infoPath, 0o000);
    try {
      assert.deepEqual(
        readRegisteredDaemonOwnership(infoPath, { pid: process.pid, startTime: 'ours' }),
        {
          state: 'unreadable',
        },
      );
    } finally {
      fs.chmodSync(infoPath, 0o600);
    }
  },
);
