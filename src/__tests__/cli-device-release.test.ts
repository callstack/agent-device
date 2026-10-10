import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { test, vi } from 'vitest';
import { readCurrentOwnerIdentity } from '@agent-device/host-kit/process';
import { createDurableResourceEnvelope } from '@agent-device/capture-kit';
import { localRuntimeOwner } from '@agent-device/contracts/platform-runtime';
import { appLogResourceStore } from '../daemon/app-log-resource-store.ts';
import { runStaleDeviceClaimRelease } from '../cli/commands/device-release.ts';
import { runCliCapture } from './cli-capture.ts';
import { mkdtempForTestSync } from './test-utils/tmp-dir.ts';

vi.mock('@agent-device/host-kit/process', async (importOriginal) =>
  (await import('./test-utils/host-process-mock.ts')).pinOwnProcessStartTime(importOriginal),
);

function hashedClaimPath(claimsDir: string, deviceKey: string): string {
  const hash = crypto.createHash('sha256').update(deviceKey).digest('hex');
  return path.join(claimsDir, `${hash}.json`);
}

function writeClaim(
  claimsDir: string,
  params: {
    deviceKey: string;
    id: string;
    name: string;
    session: string;
    ownerPid: number;
    ownerStartTime: string | null;
    stateDir: string;
  },
): void {
  fs.writeFileSync(
    hashedClaimPath(claimsDir, params.deviceKey),
    JSON.stringify({
      schemaVersion: 1,
      deviceKey: params.deviceKey,
      device: { platform: 'android', id: params.id, name: params.name, kind: 'emulator' },
      session: params.session,
      workspace: '/worktrees/release-test',
      stateDir: params.stateDir,
      ownerPid: params.ownerPid,
      ownerStartTime: params.ownerStartTime,
      ownerToken: `${params.session}-token`,
      createdAtMs: 1,
      updatedAtMs: 1,
    }),
  );
}

test('device release requires --stale and explains how live owners are released', async () => {
  const result = await runCliCapture(['device', 'release', '--json']);
  assert.equal(result.calls.length, 0);
  const payload = JSON.parse(result.stdout || result.stderr);
  assert.equal(payload.success, false);
  assert.equal(payload.error.code, 'INVALID_ARGS');
  assert.match(payload.error.message, /pass --stale to confirm/);
});

test('device release --stale settles a provably dead owner daemonlessly and refuses a live one', async () => {
  const claimsDir = mkdtempForTestSync('agent-device-cli-release-');
  const stateDir = mkdtempForTestSync('agent-device-cli-release-state-');
  const owner = readCurrentOwnerIdentity();
  try {
    writeClaim(claimsDir, {
      deviceKey: 'local:android:none:emulator-5554',
      id: 'emulator-5554',
      name: 'Dead Pixel',
      session: 'dead-session',
      ownerPid: 999_999_999,
      ownerStartTime: 'old-start-time',
      stateDir,
    });
    writeClaim(claimsDir, {
      deviceKey: 'local:android:none:emulator-5556',
      id: 'emulator-5556',
      name: 'Live Pixel',
      session: 'live-session',
      ownerPid: owner.pid,
      ownerStartTime: owner.startTime,
      stateDir: process.cwd(),
    });

    const result = await runCliCapture(['device', 'release', '--stale', '--json'], {
      env: { AGENT_DEVICE_CLAIMS_DIR: claimsDir },
    });
    assert.equal(result.calls.length, 0);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.success, true);
    assert.equal(payload.data.released.length, 1);
    assert.equal(payload.data.released[0].session, 'dead-session');
    assert.equal(payload.data.refused.length, 1);
    assert.equal(payload.data.refused[0].session, 'live-session');
    assert.equal(payload.data.refused[0].reason, 'live-owner');
    assert.equal(
      fs.existsSync(hashedClaimPath(claimsDir, 'local:android:none:emulator-5554')),
      false,
    );
    assert.equal(
      fs.existsSync(hashedClaimPath(claimsDir, 'local:android:none:emulator-5556')),
      true,
    );
  } finally {
    fs.rmSync(claimsDir, { recursive: true, force: true });
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test('device status --stale offers the exact release command for provably dead owners', async () => {
  const claimsDir = mkdtempForTestSync('agent-device-cli-release-');
  try {
    writeClaim(claimsDir, {
      deviceKey: 'local:android:none:emulator-5554',
      id: 'emulator-5554',
      name: 'Dead Pixel',
      session: 'dead-session',
      ownerPid: 999_999_999,
      ownerStartTime: 'old-start-time',
      stateDir: process.cwd(),
    });

    const result = await runCliCapture(['device', 'status', '--stale'], {
      env: { AGENT_DEVICE_CLAIMS_DIR: claimsDir },
    });
    assert.match(
      result.stdout,
      /Release provably dead owners with: agent-device device release --stale/,
    );
  } finally {
    fs.rmSync(claimsDir, { recursive: true, force: true });
  }
});

test('device release --stale renders per-claim outcomes with a live-owner hint in text mode', async () => {
  const claimsDir = mkdtempForTestSync('agent-device-cli-release-');
  const stateDir = mkdtempForTestSync('agent-device-cli-release-state-');
  const owner = readCurrentOwnerIdentity();
  try {
    writeClaim(claimsDir, {
      deviceKey: 'local:android:none:emulator-5554',
      id: 'emulator-5554',
      name: 'Dead Pixel',
      session: 'dead-session',
      ownerPid: 999_999_999,
      ownerStartTime: 'old-start-time',
      stateDir,
    });
    writeClaim(claimsDir, {
      deviceKey: 'local:android:none:emulator-5556',
      id: 'emulator-5556',
      name: 'Live Pixel',
      session: 'live-session',
      ownerPid: owner.pid,
      ownerStartTime: owner.startTime,
      stateDir: process.cwd(),
    });

    const result = await runCliCapture(['device', 'release', '--stale'], {
      env: { AGENT_DEVICE_CLAIMS_DIR: claimsDir },
    });
    assert.match(result.stdout, /released android Dead Pixel session=dead-session/);
    assert.match(result.stdout, /refused android Live Pixel session=live-session[^\n]*live-owner/);
    assert.match(result.stdout, /agent-device daemon stop --state-dir/);
  } finally {
    fs.rmSync(claimsDir, { recursive: true, force: true });
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test('device release --stale keeps the claim while durable resources cannot be settled', async () => {
  const claimsDir = mkdtempForTestSync('agent-device-cli-release-');
  const ownerStateDir = mkdtempForTestSync('agent-device-cli-release-owner-');
  try {
    writeClaim(claimsDir, {
      deviceKey: 'local:android:none:emulator-5554',
      id: 'emulator-5554',
      name: 'Dead Pixel',
      session: 'dead-session',
      ownerPid: 999_999_999,
      ownerStartTime: 'old-start-time',
      stateDir: ownerStateDir,
    });
    // The dead owner left an attributable durable resource whose recorded
    // device is NOT this claim's device: exact-owner recovery refuses it, and
    // the claim must survive until the resource reaches a terminal state.
    const resourcePath = appLogResourceStore.resolvePath(
      path.join(ownerStateDir, 'sessions', 'dead-session'),
    );
    appLogResourceStore.write(
      resourcePath,
      createDurableResourceEnvelope({
        resourceKind: 'app-log',
        sessionId: 'dead-session',
        device: { id: 'some-other-device', family: 'android', kind: 'emulator' },
        owner: localRuntimeOwner('android'),
        fence: { token: 'fence', generation: 1 },
        lifecycle: 'open',
        descriptor: { version: 1, body: { pid: 123 } },
      }),
    );

    const result = await runCliCapture(['device', 'release', '--stale', '--json'], {
      env: { AGENT_DEVICE_CLAIMS_DIR: claimsDir },
    });
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.success, true);
    assert.equal(payload.data.released.length, 0);
    assert.equal(payload.data.retained.length, 1);
    assert.equal(payload.data.retained[0].reason, 'app-log-owner-mismatch');
    assert.equal(
      fs.existsSync(hashedClaimPath(claimsDir, 'local:android:none:emulator-5554')),
      true,
    );
    assert.equal(fs.existsSync(resourcePath), true);
  } finally {
    fs.rmSync(claimsDir, { recursive: true, force: true });
    fs.rmSync(ownerStateDir, { recursive: true, force: true });
  }
});

test('device release --stale keeps the claim when resource evidence is unreadable', async () => {
  const claimsDir = mkdtempForTestSync('agent-device-cli-release-');
  const ownerStateDir = mkdtempForTestSync('agent-device-cli-release-owner-');
  try {
    writeClaim(claimsDir, {
      deviceKey: 'local:android:none:emulator-5554',
      id: 'emulator-5554',
      name: 'Dead Pixel',
      session: 'dead-session',
      ownerPid: 999_999_999,
      ownerStartTime: 'old-start-time',
      stateDir: ownerStateDir,
    });
    const resourcePath = appLogResourceStore.resolvePath(
      path.join(ownerStateDir, 'sessions', 'dead-session'),
    );
    fs.mkdirSync(path.dirname(resourcePath), { recursive: true });
    fs.writeFileSync(resourcePath, '{');

    const result = await runCliCapture(['device', 'release', '--stale', '--json'], {
      env: { AGENT_DEVICE_CLAIMS_DIR: claimsDir },
    });
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.data.retained.length, 1);
    assert.equal(payload.data.retained[0].reason, 'app-log-descriptor-invalid');
    assert.equal(
      fs.existsSync(hashedClaimPath(claimsDir, 'local:android:none:emulator-5554')),
      true,
    );
  } finally {
    fs.rmSync(claimsDir, { recursive: true, force: true });
    fs.rmSync(ownerStateDir, { recursive: true, force: true });
  }
});

test('recovery is composed per claim from the stale owner state dir, never the caller', async () => {
  const claimsDir = mkdtempForTestSync('agent-device-cli-release-');
  const ownerDirA = mkdtempForTestSync('agent-device-cli-release-owner-a-');
  const ownerDirB = mkdtempForTestSync('agent-device-cli-release-owner-b-');
  try {
    // Two dead owners with the SAME session name in different state dirs: the
    // adversarial shape from review — one caller-scoped store would clear the
    // wrong worktree's records for that session name.
    writeClaim(claimsDir, {
      deviceKey: 'local:android:none:emulator-5554',
      id: 'emulator-5554',
      name: 'Dead Pixel A',
      session: 'shared-session',
      ownerPid: 999_999_999,
      ownerStartTime: 'old-start-time',
      stateDir: ownerDirA,
    });
    writeClaim(claimsDir, {
      deviceKey: 'local:android:none:emulator-5556',
      id: 'emulator-5556',
      name: 'Dead Pixel B',
      session: 'shared-session',
      ownerPid: 999_999_999,
      ownerStartTime: 'old-start-time',
      stateDir: ownerDirB,
    });
    process.env.AGENT_DEVICE_CLAIMS_DIR = claimsDir;

    const composedFor: string[] = [];
    const outcomes = await runStaleDeviceClaimRelease({}, (stateDir) => {
      composedFor.push(stateDir);
      return {
        reconcile: async (claim) => {
          assert.equal(claim.stateDir, stateDir);
          return { status: 'reconciled' };
        },
        dispose: async () => {},
      };
    });

    assert.deepEqual([...composedFor].sort(), [ownerDirA, ownerDirB].sort());
    assert.equal(outcomes.filter((outcome) => outcome.status === 'released').length, 2);
  } finally {
    delete process.env.AGENT_DEVICE_CLAIMS_DIR;
    fs.rmSync(claimsDir, { recursive: true, force: true });
    fs.rmSync(ownerDirA, { recursive: true, force: true });
    fs.rmSync(ownerDirB, { recursive: true, force: true });
  }
});
