import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'vitest';
import { pruneDeadDeviceClaims } from '../device-claim-inspection.ts';
import { readCurrentOwnerIdentity } from '../../utils/owner-identity.ts';

const previousClaimsDir = process.env.AGENT_DEVICE_CLAIMS_DIR;

afterEach(() => {
  process.env.AGENT_DEVICE_CLAIMS_DIR = previousClaimsDir;
});

function writeClaim(
  claimsDir: string,
  fileName: string,
  overrides: { ownerPid: number; ownerStartTime?: string | null; stateDir?: string },
): void {
  fs.writeFileSync(
    path.join(claimsDir, fileName),
    JSON.stringify({
      schemaVersion: 1,
      deviceKey: `local:android:none:${fileName}`,
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

test('prunes claims whose owner is gone and keeps every other claim', () => {
  const claimsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-prune-claims-'));
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

    const { pruned } = pruneDeadDeviceClaims();

    assert.equal(pruned, 1);
    assert.equal(fs.existsSync(path.join(claimsDir, 'dead.json')), false);
    assert.equal(fs.existsSync(path.join(claimsDir, 'live.json')), true);
    assert.equal(fs.existsSync(path.join(claimsDir, 'state-dir-gone.json')), true);
    assert.equal(fs.existsSync(path.join(claimsDir, 'garbage.json')), true);
  } finally {
    fs.rmSync(claimsDir, { recursive: true, force: true });
  }
});

test('prunes nothing when the claim store does not exist', () => {
  process.env.AGENT_DEVICE_CLAIMS_DIR = path.join(os.tmpdir(), 'agent-device-prune-absent-store');
  assert.deepEqual(pruneDeadDeviceClaims(), { pruned: 0 });
});
