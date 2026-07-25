import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'vitest';
import { readCurrentOwnerIdentity } from '../utils/owner-identity.ts';
import { runCliCapture } from './cli-capture.ts';

test('device status is daemonless and does not send a daemon request', async () => {
  const result = await runCliCapture(['device', 'status', '--json']);
  assert.equal(result.code, null);
  assert.equal(result.calls.length, 0);
  const payload = JSON.parse(result.stdout);
  assert.deepEqual(payload, { success: true, data: { claims: [], hiddenStaleClaims: 0 } });
});

test('keeps normal status compact while retaining proven-stale claims for explicit inspection', async () => {
  const claimsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-cli-claims-'));
  const owner = readCurrentOwnerIdentity();
  try {
    fs.writeFileSync(
      path.join(claimsDir, 'live.json'),
      JSON.stringify({
        schemaVersion: 1,
        deviceKey: 'local:android:none:live',
        device: { platform: 'android', id: 'live', name: 'Live Pixel', kind: 'emulator' },
        session: 'live-session',
        workspace: '/worktrees/live',
        stateDir: process.cwd(),
        ownerPid: owner.pid,
        ownerStartTime: owner.startTime,
        ownerToken: 'live-token',
        createdAtMs: 1,
        updatedAtMs: 1,
      }),
    );
    fs.writeFileSync(
      path.join(claimsDir, 'stale.json'),
      JSON.stringify({
        schemaVersion: 1,
        deviceKey: 'local:android:none:stale',
        device: {
          platform: 'android',
          id: 'stale',
          name: 'Stale Pixel; echo no',
          kind: 'emulator',
        },
        session: 'stale-session',
        workspace: '/worktrees/stale',
        stateDir: process.cwd(),
        ownerPid: 999_999_999,
        ownerStartTime: 'old-start-time',
        ownerToken: 'stale-token',
        createdAtMs: 1,
        updatedAtMs: 1,
      }),
    );

    const normal = await runCliCapture(['device', 'status'], {
      env: { AGENT_DEVICE_CLAIMS_DIR: claimsDir },
    });
    assert.equal(normal.code, null);
    assert.equal(normal.calls.length, 0);
    assert.match(normal.stdout, /Live Pixel: live/);
    assert.match(
      normal.stdout,
      /1 stale claim hidden; inspect with: agent-device device status --stale/,
    );
    assert.doesNotMatch(normal.stdout, /Stale Pixel/);

    const stale = await runCliCapture(['device', 'status', '--stale', '--json'], {
      env: { AGENT_DEVICE_CLAIMS_DIR: claimsDir },
    });
    assert.equal(stale.code, null);
    assert.equal(stale.calls.length, 0);
    const payload = JSON.parse(stale.stdout);
    assert.equal(payload.data.claims.length, 1);
    assert.equal(payload.data.claims[0].device.name, 'Stale Pixel; echo no');
    assert.equal(payload.data.claims[0].recovery, undefined);

    const scoped = await runCliCapture(['device', 'status', '--device', 'Stale Pixel; echo no'], {
      env: { AGENT_DEVICE_CLAIMS_DIR: claimsDir },
    });
    assert.match(
      scoped.stdout,
      /inspect with: agent-device device status --device 'Stale Pixel; echo no' --stale/,
    );
  } finally {
    fs.rmSync(claimsDir, { recursive: true, force: true });
  }
});

test('keeps corrupt and state-dir-gone claims visible in normal status', async () => {
  const claimsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-cli-claims-'));
  const owner = readCurrentOwnerIdentity();
  try {
    fs.writeFileSync(path.join(claimsDir, 'corrupt.json'), '{bad json');
    fs.writeFileSync(
      path.join(claimsDir, 'state-dir-gone.json'),
      JSON.stringify({
        schemaVersion: 1,
        deviceKey: 'local:android:none:state-dir-gone',
        device: {
          platform: 'android',
          id: 'state-dir-gone',
          name: 'State-dir-gone Pixel',
          kind: 'emulator',
        },
        session: 'state-dir-gone-session',
        workspace: '/worktrees/state-dir-gone',
        stateDir: path.join(claimsDir, 'missing-state-dir'),
        ownerPid: owner.pid,
        ownerStartTime: owner.startTime,
        ownerToken: 'state-dir-gone-token',
        createdAtMs: 1,
        updatedAtMs: 1,
      }),
    );

    const normal = await runCliCapture(['device', 'status'], {
      env: { AGENT_DEVICE_CLAIMS_DIR: claimsDir },
    });
    assert.match(normal.stdout, /corrupt.json: inconsistent/);
    assert.doesNotMatch(normal.stdout, /State-dir-gone Pixel/);
    assert.match(normal.stdout, /1 stale claim hidden/);

    const stale = await runCliCapture(['device', 'status', '--stale'], {
      env: { AGENT_DEVICE_CLAIMS_DIR: claimsDir },
    });
    assert.match(stale.stdout, /State-dir-gone Pixel: owner-state-dir-gone/);
  } finally {
    fs.rmSync(claimsDir, { recursive: true, force: true });
  }
});
