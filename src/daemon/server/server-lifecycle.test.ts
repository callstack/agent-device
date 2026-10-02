import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test, vi } from 'vitest';
import { mkdtempForTestSync } from '../../__tests__/test-utils/tmp-dir.ts';
import type { OwnerIdentity } from '@agent-device/host-kit/process';
import { removeInfoOwnedBy, writeInfo } from './server-lifecycle.ts';
import { readRegisteredDaemonOwnership } from '../../daemon-registration.ts';

const OWN_PID = process.pid;
const SUCCESSOR_PID = 999_999_999;
const START_TIME = 'own-start-time';
const SUCCESSOR_START_TIME = 'successor-start-time';

const OWN_IDENTITY: OwnerIdentity = { pid: OWN_PID, startTime: START_TIME };

function scratchInfoPath(name = 'daemon.json'): [stateDir: string, infoPath: string] {
  const stateDir = mkdtempForTestSync('agent-device-server-lifecycle-');
  return [stateDir, path.join(stateDir, name)];
}

function writeRegistration(
  pid: number,
  startTime: string | null,
  name = 'daemon.json',
): [string, string] {
  const [stateDir, infoPath] = scratchInfoPath(name);
  fs.writeFileSync(
    infoPath,
    JSON.stringify({
      pid,
      ...(startTime === null ? {} : { processStartTime: startTime }),
      token: 'token',
      port: 4210,
    }),
  );
  return [stateDir, infoPath];
}

test('the daemon named by daemon.json removes its own registration', () => {
  const [, infoPath] = writeRegistration(OWN_PID, START_TIME);

  assert.deepEqual(removeInfoOwnedBy(infoPath, OWN_IDENTITY), { removed: true });
  assert.equal(fs.existsSync(infoPath), false);
});

test('a successor published over the metadata keeps its record through the predecessor shutdown', () => {
  const [, infoPath] = writeRegistration(SUCCESSOR_PID, SUCCESSOR_START_TIME);

  assert.deepEqual(removeInfoOwnedBy(infoPath, OWN_IDENTITY), {
    removed: false,
    reason: 'replaced',
    registeredPid: SUCCESSOR_PID,
  });
  assert.equal(fs.existsSync(infoPath), true);
  assert.equal(
    (JSON.parse(fs.readFileSync(infoPath, 'utf8')) as { pid: number }).pid,
    SUCCESSOR_PID,
  );
});

test('a record recycling our pid after our start time is not ours to remove', () => {
  // The pid is not an identity. Removing the successor's record here is the same #3087 failure the
  // issue describes, just reached through PID reuse instead of a second daemon.
  const [, infoPath] = writeRegistration(OWN_PID, SUCCESSOR_START_TIME);

  assert.deepEqual(removeInfoOwnedBy(infoPath, OWN_IDENTITY), {
    removed: false,
    reason: 'replaced',
    registeredPid: OWN_PID,
  });
  assert.equal(fs.existsSync(infoPath), true);
});

test('a record agreeing on pid alone is refused, not removed on the strength of the pid', () => {
  // One side cannot read its own start time, so nothing proves this record is ours. Removing it would
  // be the pid-only rule the fence exists to replace; keeping it costs a client one liveness probe.
  const [, infoPath] = writeRegistration(OWN_PID, null);

  assert.deepEqual(removeInfoOwnedBy(infoPath, OWN_IDENTITY), {
    removed: false,
    reason: 'unproven',
  });
  assert.equal(fs.existsSync(infoPath), true);
});

test('an absent registration is nothing to remove', () => {
  const [, infoPath] = scratchInfoPath();

  assert.deepEqual(removeInfoOwnedBy(infoPath, OWN_IDENTITY), { removed: false, reason: 'absent' });
});

test('a corrupt or pid-less registration names no owner, so it is refused and kept', () => {
  const [stateDir, corrupt] = scratchInfoPath('corrupt.json');
  fs.writeFileSync(corrupt, '{not json');
  assert.deepEqual(removeInfoOwnedBy(corrupt, OWN_IDENTITY), {
    removed: false,
    reason: 'ownerless',
  });
  assert.equal(
    fs.existsSync(corrupt),
    true,
    'a record that names no owner is not this pid to delete',
  );

  for (const pid of [0, -3, 1.5, '7', null]) {
    const pidLess = path.join(stateDir, `pid-less-${String(pid)}.json`);
    fs.writeFileSync(pidLess, JSON.stringify({ pid, token: 'token' }));
    assert.deepEqual(removeInfoOwnedBy(pidLess, OWN_IDENTITY), {
      removed: false,
      reason: 'ownerless',
    });
    assert.equal(fs.existsSync(pidLess), true);
  }
});

test.skipIf(process.getuid?.() === 0)(
  'a registration this process cannot read is kept, not treated as removed',
  () => {
    // EACCES is not evidence that the record is gone, and a root-owned CI host reads mode 000
    // anyway. Treating it as gone would repeat #3087 from the other side: a live daemon loses its
    // metadata to a shutdown whose read failed.
    const [, infoPath] = writeRegistration(OWN_PID, START_TIME, 'unreadable.json');
    fs.chmodSync(infoPath, 0o000);
    try {
      assert.deepEqual(removeInfoOwnedBy(infoPath, OWN_IDENTITY), {
        removed: false,
        reason: 'unreadable',
      });
      assert.equal(fs.existsSync(infoPath), true);
    } finally {
      fs.chmodSync(infoPath, 0o600);
    }
  },
);

test('the record is read at removal time, not remembered from publication', () => {
  const [stateDir, infoPath] = scratchInfoPath();
  const publish = (port: number) =>
    writeInfo(stateDir, infoPath, path.join(stateDir, 'daemon.log'), {
      socketPort: port,
      token: 'token',
      version: '0.0.0-test',
      codeOrigin: 'checkout',
      codeSignature: 'signature',
      processStartTime: START_TIME,
    });

  publish(4210);
  assert.deepEqual(removeInfoOwnedBy(infoPath, OWN_IDENTITY), { removed: true });

  publish(4211);
  fs.writeFileSync(
    infoPath,
    JSON.stringify({ pid: SUCCESSOR_PID, processStartTime: SUCCESSOR_START_TIME, port: 4211 }),
  );
  assert.deepEqual(removeInfoOwnedBy(infoPath, OWN_IDENTITY), {
    removed: false,
    reason: 'replaced',
    registeredPid: SUCCESSOR_PID,
  });
});

test('publication replaces the record by rename, never by an in-place write', () => {
  // A torn `daemon.json` decodes to "names no owner", which every reader refuses to remove and the
  // loss watch could misread. An in-place write exposes exactly such a window; a rename does not,
  // and the inode swap is what distinguishes the two from the outside.
  const [stateDir, infoPath] = scratchInfoPath();
  const publish = () =>
    writeInfo(stateDir, infoPath, path.join(stateDir, 'daemon.log'), {
      socketPort: 4210,
      token: 'token',
      version: '0.0.0-test',
      codeOrigin: 'checkout',
      codeSignature: 'signature',
      processStartTime: START_TIME,
    });

  publish();
  const before = fs.statSync(infoPath).ino;
  publish();

  assert.notEqual(fs.statSync(infoPath).ino, before, 'republication must not reuse the inode');
  assert.equal(readRegisteredDaemonOwnership(infoPath, OWN_IDENTITY).state, 'match');
});

test('a registration already gone by the time of the unlink is not an error', () => {
  const [, infoPath] = writeRegistration(OWN_PID, START_TIME);
  const unlinkSync = vi.spyOn(fs, 'unlinkSync').mockImplementation(() => {
    const error = new Error('ENOENT') as NodeJS.ErrnoException;
    error.code = 'ENOENT';
    throw error;
  });
  try {
    assert.deepEqual(removeInfoOwnedBy(infoPath, OWN_IDENTITY), { removed: true });
  } finally {
    unlinkSync.mockRestore();
  }
});

test('a failing unlink other than ENOENT surfaces instead of reporting a removal', () => {
  const [, infoPath] = writeRegistration(OWN_PID, START_TIME);
  const unlinkSync = vi.spyOn(fs, 'unlinkSync').mockImplementation(() => {
    throw new Error('EBUSY');
  });
  try {
    assert.throws(() => removeInfoOwnedBy(infoPath, OWN_IDENTITY), /EBUSY/);
  } finally {
    unlinkSync.mockRestore();
  }
});
