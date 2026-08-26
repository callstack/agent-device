import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, test } from 'vitest';
import { isSupersededDaemonOwner, readRegisteredDaemonIdentity } from '../daemon-registration.ts';
import { writeInfo } from '../server/server-lifecycle.ts';
import { publishDaemonRegistration } from '../../__tests__/test-utils/device-claim-store.ts';
import { mkdtempForTestSync } from '../../__tests__/test-utils/tmp-dir.ts';

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
  writeInfo(stateDir, infoPathOf(stateDir), path.join(stateDir, 'daemon.log'), {
    socketPort: 1234,
    token: 'token',
    version: '0.0.0-test',
    codeSignature: 'signature',
    processStartTime: 'published-start',
  });

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

test('a published start time proves supersession only when both sides are readable', () => {
  const stateDir = useStateDir();
  publishDaemonRegistration(stateDir, { pid: 4242, startTime: 'successor-start' });
  assert.equal(isSupersededDaemonOwner({ stateDir, pid: 4242, startTime: 'owner-start' }), true);
  // An unreadable start time on either side leaves the identity unproven.
  assert.equal(isSupersededDaemonOwner({ stateDir, pid: 4242, startTime: null }), false);
  publishDaemonRegistration(stateDir, { pid: 4242, startTime: null });
  assert.equal(isSupersededDaemonOwner({ stateDir, pid: 4242, startTime: 'owner-start' }), false);
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
