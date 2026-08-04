import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'vitest';
import { pruneDeadDeviceClaims } from '../device-claims.ts';
import { resolveDeviceClaimPath } from '../device-claim-paths.ts';
import { acquireProcessLock } from '../../utils/process-lock.ts';
import { readCurrentOwnerIdentity } from '../../utils/owner-identity.ts';
import { mkdtempForTestSync } from '../../__tests__/test-utils/tmp-dir.ts';

const previousClaimsDir = process.env.AGENT_DEVICE_CLAIMS_DIR;

afterEach(() => {
  process.env.AGENT_DEVICE_CLAIMS_DIR = previousClaimsDir;
});

// Claims live at the hash of their device key; the prune only touches a file
// that is the canonical path for the key it contains.
function writeClaim(
  _claimsDir: string,
  fileName: string,
  overrides: { ownerPid: number; ownerStartTime?: string | null; stateDir?: string },
): void {
  const deviceKey = `local:android:none:${fileName}`;
  fs.writeFileSync(
    resolveDeviceClaimPath(deviceKey),
    JSON.stringify({
      schemaVersion: 1,
      deviceKey,
      device: { platform: 'android', id: fileName, name: fileName, kind: 'emulator' },
      session: `${fileName}-session`,
      workspace: '/worktrees/x',
      stateDir: overrides.stateDir ?? process.cwd(),
      ownerPid: overrides.ownerPid,
      ownerStartTime: overrides.ownerStartTime ?? undefined,
      ownerToken: `${fileName}-token`,
      createdAtMs: 1,
      updatedAtMs: 1,
    }),
  );
}

test('prunes claims whose owner is gone and keeps every other claim', async () => {
  const claimsDir = mkdtempForTestSync('agent-device-prune-claims-');
  process.env.AGENT_DEVICE_CLAIMS_DIR = claimsDir;
  const owner = readCurrentOwnerIdentity();
  try {
    writeClaim(claimsDir, 'dead.json', { ownerPid: 999_999_999, ownerStartTime: 'old' });
    writeClaim(claimsDir, 'live.json', { ownerPid: owner.pid, ownerStartTime: owner.startTime });
    // Live process whose state dir vanished: pruning this could hand its device
    // to a second session, so it is reported stale but never deleted.
    writeClaim(claimsDir, 'state-dir-gone.json', {
      ownerPid: owner.pid,
      ownerStartTime: owner.startTime,
      stateDir: path.join(claimsDir, 'missing-state-dir'),
    });
    fs.writeFileSync(path.join(claimsDir, 'garbage.json'), 'not json');

    const { pruned } = await pruneDeadDeviceClaims();

    const claimPathFor = (name: string) => resolveDeviceClaimPath(`local:android:none:${name}`);
    assert.equal(pruned, 1);
    assert.equal(fs.existsSync(claimPathFor('dead.json')), false);
    assert.equal(fs.existsSync(claimPathFor('live.json')), true);
    assert.equal(fs.existsSync(claimPathFor('state-dir-gone.json')), true);
    assert.equal(fs.existsSync(path.join(claimsDir, 'garbage.json')), true);
  } finally {
    fs.rmSync(claimsDir, { recursive: true, force: true });
  }
});

test('prunes nothing when the claim store does not exist', async () => {
  process.env.AGENT_DEVICE_CLAIMS_DIR = path.join(os.tmpdir(), 'agent-device-prune-absent-store');
  assert.deepEqual(await pruneDeadDeviceClaims(), { pruned: 0 });
});

test('leaves a live successor written while the prune waited for the claim lock', async () => {
  // Claim paths are derived from the device key, so a concurrent daemon can
  // prune the same dead claim and a new session can write its live successor
  // to that exact path. Holding the lock here reproduces that window: the scan
  // sees a dead claim, then the file is replaced before the prune can unlink.
  const claimsDir = mkdtempForTestSync('agent-device-prune-race-');
  process.env.AGENT_DEVICE_CLAIMS_DIR = claimsDir;
  const owner = readCurrentOwnerIdentity();
  const deviceKey = 'local:android:none:contested';
  const claimPath = resolveDeviceClaimPath(deviceKey);
  const writeContested = (ownerPid: number, ownerStartTime: string | null, token: string) => {
    fs.writeFileSync(
      claimPath,
      JSON.stringify({
        schemaVersion: 1,
        deviceKey,
        device: { platform: 'android', id: 'contested', name: 'Contested', kind: 'emulator' },
        session: 'contested-session',
        workspace: '/worktrees/x',
        stateDir: process.cwd(),
        ownerPid,
        ownerStartTime: ownerStartTime ?? undefined,
        ownerToken: token,
        createdAtMs: 1,
        updatedAtMs: 1,
      }),
    );
  };

  try {
    writeContested(999_999_999, 'old', 'dead-token');

    const release = await acquireProcessLock({
      lockDirPath: `${claimPath}.lock`,
      owner: { pid: owner.pid, startTime: owner.startTime, acquiredAtMs: Date.now() },
      timeoutMs: 5_000,
      description: 'test-held device claim lock',
    });

    const pruning = pruneDeadDeviceClaims();
    // The prune is now blocked on the lock; stand in the live successor.
    writeContested(owner.pid, owner.startTime, 'live-token');
    await release();

    assert.deepEqual(await pruning, { pruned: 0 });
    assert.equal(fs.existsSync(claimPath), true);
    assert.equal(JSON.parse(fs.readFileSync(claimPath, 'utf8')).ownerToken, 'live-token');
  } finally {
    fs.rmSync(claimsDir, { recursive: true, force: true });
  }
});
