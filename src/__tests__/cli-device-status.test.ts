import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'vitest';
import * as hostProcess from '@agent-device/host-kit/process';
import { readCurrentOwnerIdentity } from '@agent-device/host-kit/process';
import { createDurableResourceEnvelope } from '@agent-device/capture-kit';
import { screenRecordingDurableResource } from '@agent-device/capture-kit/screen-recording-session-resource';
import { localRuntimeOwner } from '@agent-device/contracts/platform-runtime';
import { inspectDeviceClaimAdmission } from '@agent-device/daemon-contracts/device-claim-recovery';
import { runCliCapture } from './cli-capture.ts';
import {
  mkdtempForTestSync,
  pinOwnProcessStartTime,
  publishDaemonRegistration,
} from '@agent-device/test-kit';

pinOwnProcessStartTime(hostProcess);

test('device status is daemonless and does not send a daemon request', async () => {
  const result = await runCliCapture(['device', 'status', '--json']);
  assert.equal(result.code, null);
  assert.equal(result.calls.length, 0);
  const payload = JSON.parse(result.stdout);
  assert.deepEqual(payload, {
    success: true,
    data: { claims: [], hiddenStaleClaims: 0, devices: [] },
  });
});

test('keeps normal status compact while retaining proven-stale claims for explicit inspection', async () => {
  const claimsDir = mkdtempForTestSync('agent-device-cli-claims-');
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

test('reports per device whether a new session can take it, with the blocking reason', async () => {
  const claimsDir = mkdtempForTestSync('agent-device-cli-claims-');
  const ownerStateDir = mkdtempForTestSync('agent-device-cli-claims-owner-');
  const owner = readCurrentOwnerIdentity();
  const write = (
    deviceKey: string,
    id: string,
    params: { ownerPid: number; ownerStartTime: string | null; stateDir: string },
  ) =>
    fs.writeFileSync(
      path.join(claimsDir, `${cryptoHashForTest(deviceKey)}.json`),
      JSON.stringify({
        schemaVersion: 1,
        deviceKey,
        device: { platform: 'android', id, name: id, kind: 'emulator' },
        session: `session-${id}`,
        workspace: '/worktrees/owner',
        stateDir: params.stateDir,
        ownerPid: params.ownerPid,
        ownerStartTime: params.ownerStartTime,
        ownerToken: 'owner-token',
        createdAtMs: 1,
        updatedAtMs: 1,
      }),
    );
  try {
    write('local:android:none:held', 'held', {
      ownerPid: owner.pid,
      ownerStartTime: owner.startTime,
      stateDir: process.cwd(),
    });
    write('local:android:none:reclaimable', 'reclaimable', {
      ownerPid: 999_999_999,
      ownerStartTime: 'old-start-time',
      stateDir: ownerStateDir,
    });
    write('local:android:none:retained', 'retained', {
      ownerPid: 999_999_999,
      ownerStartTime: 'old-start-time',
      stateDir: ownerStateDir,
    });
    const recordingPath = screenRecordingDurableResource.store.resolvePath(
      path.join(ownerStateDir, 'sessions', 'session-retained'),
    );
    screenRecordingDurableResource.store.write(
      recordingPath,
      createDurableResourceEnvelope({
        resourceKind: 'screen-recording',
        sessionId: 'session-retained',
        device: { id: 'retained', family: 'android', kind: 'emulator' },
        owner: localRuntimeOwner('android'),
        fence: { token: 'fence', generation: 1 },
        lifecycle: 'open',
        descriptor: { version: 1, body: {} },
      }),
    );

    const result = await runCliCapture(['device', 'status', '--json'], {
      env: { AGENT_DEVICE_CLAIMS_DIR: claimsDir },
    });
    assert.equal(result.code, null);
    const devices = JSON.parse(result.stdout).data.devices;
    const byId = Object.fromEntries(
      devices.map((entry: { device: { id: string } }) => [entry.device.id, entry]),
    );
    assert.equal(byId.held.acquirable, false);
    assert.equal(byId.held.blockedBy, 'live-owner');
    assert.equal(byId.held.owner.session, 'session-held');
    // #4524: the Expo Explore case. A provably dead owner is no longer read as blocking.
    assert.equal(byId.reclaimable.acquirable, true);
    assert.equal(byId.reclaimable.blockedBy, undefined);
    assert.equal(byId.reclaimable.owner.session, 'session-reclaimable');
    assert.equal(byId.retained.acquirable, false);
    assert.equal(byId.retained.blockedBy, 'screen-recording-cleanup-pending');
  } finally {
    fs.rmSync(claimsDir, { recursive: true, force: true });
    fs.rmSync(ownerStateDir, { recursive: true, force: true });
  }
});

test('a device selector still weighs the host claim that overlaps the selected app device', async () => {
  const claimsDir = mkdtempForTestSync('agent-device-cli-claims-');
  const owner = readCurrentOwnerIdentity();
  const write = (id: string, name: string, ownerPid: number, ownerStartTime: string | null) => {
    const deviceKey = `local:web:none:${id}`;
    fs.writeFileSync(
      path.join(claimsDir, `${cryptoHashForTest(deviceKey)}.json`),
      JSON.stringify({
        schemaVersion: 1,
        deviceKey,
        device: { platform: 'web', id, name, kind: 'device' },
        session: `session-${name}`,
        workspace: '/worktrees/owner',
        stateDir: process.cwd(),
        ownerPid,
        ownerStartTime,
        ownerToken: 'owner-token',
        createdAtMs: 1,
        updatedAtMs: 1,
      }),
    );
  };
  try {
    write('chrome', 'Host Chrome', owner.pid, owner.startTime);
    write('chrome:app:com.example.app', 'Example App', 999_999_999, 'old-start-time');

    const result = await runCliCapture(['device', 'status', '--device', 'Example App', '--json'], {
      env: { AGENT_DEVICE_CLAIMS_DIR: claimsDir },
    });
    const data = JSON.parse(result.stdout).data;
    // The selector scopes the listing to the app's own (stale, hidden) claim.
    assert.deepEqual(data.claims, []);
    assert.equal(data.hiddenStaleClaims, 1);
    assert.equal(data.devices.length, 1);
    assert.equal(data.devices[0].device.id, 'chrome:app:com.example.app');
    assert.equal(data.devices[0].acquirable, false);
    assert.equal(data.devices[0].blockedBy, 'live-owner');
    assert.equal(data.devices[0].owner.session, 'session-Host Chrome');
  } finally {
    fs.rmSync(claimsDir, { recursive: true, force: true });
  }
});

// Status and `open` read one admission verdict. These tests ask it the way `open` does, as a session of
// another daemon, and require the status report to name the same refusal.
async function openAdmissionFor(
  claimsDir: string,
  device: { id: string; platform: 'android' | 'web' },
) {
  const admission = await inspectDeviceClaimAdmission({
    device: { ...device, name: device.id, kind: 'device' },
    command: 'open',
    session: 'other-session',
    workspace: '/worktrees/other',
    stateDir: '/other-daemon-state',
    env: { AGENT_DEVICE_CLAIMS_DIR: claimsDir },
    coveredClaimIsOwnedByRequest: () => false,
  });
  return admission.status === 'refused'
    ? { acquirable: false, session: admission.conflict.claim?.session }
    : { acquirable: true };
}

function claimJson(params: {
  deviceKey: string;
  id: string;
  platform: 'android' | 'web';
  session: string;
  stateDir: string;
  ownerPid: number;
  ownerStartTime: string | null;
  abandonedAtMs?: number;
}): string {
  return JSON.stringify({
    schemaVersion: 1,
    device: { platform: params.platform, id: params.id, name: params.id, kind: 'device' },
    workspace: '/worktrees/owner',
    ownerToken: 'owner-token',
    createdAtMs: 1,
    updatedAtMs: 1,
    ...params,
  });
}

async function statusDevices(claimsDir: string) {
  const result = await runCliCapture(['device', 'status', '--json'], {
    env: { AGENT_DEVICE_CLAIMS_DIR: claimsDir },
  });
  return JSON.parse(result.stdout).data as {
    claims: { classification: string }[];
    devices: {
      device: { id: string };
      acquirable: boolean;
      blockedBy?: string;
      owner?: { session: string };
    }[];
  };
}

test('status and open agree on an abandoned claim of a running daemon', async () => {
  const claimsDir = mkdtempForTestSync('agent-device-cli-claims-');
  const owner = readCurrentOwnerIdentity();
  try {
    const deviceKey = 'local:android:none:emulator-5562';
    fs.writeFileSync(
      path.join(claimsDir, `${cryptoHashForTest(deviceKey)}.json`),
      claimJson({
        deviceKey,
        id: 'emulator-5562',
        platform: 'android',
        session: 'abandoned-session',
        stateDir: process.cwd(),
        ownerPid: owner.pid,
        ownerStartTime: owner.startTime,
        abandonedAtMs: 5,
      }),
    );

    const [entry] = (await statusDevices(claimsDir)).devices;
    const open = await openAdmissionFor(claimsDir, { id: 'emulator-5562', platform: 'android' });
    assert.equal(entry?.acquirable, false);
    assert.equal(entry?.blockedBy, 'live-owner');
    assert.equal(open.acquirable, false);
    assert.equal(entry?.owner?.session, open.session);
  } finally {
    fs.rmSync(claimsDir, { recursive: true, force: true });
  }
});

test('status and open agree on a claim stored under a noncanonical file name', async () => {
  const claimsDir = mkdtempForTestSync('agent-device-cli-claims-');
  const owner = readCurrentOwnerIdentity();
  try {
    fs.writeFileSync(
      path.join(claimsDir, 'renamed.json'),
      claimJson({
        deviceKey: 'local:android:none:emulator-5564',
        id: 'emulator-5564',
        platform: 'android',
        session: 'renamed-session',
        stateDir: process.cwd(),
        ownerPid: owner.pid,
        ownerStartTime: owner.startTime,
      }),
    );

    const [entry] = (await statusDevices(claimsDir)).devices;
    const open = await openAdmissionFor(claimsDir, { id: 'emulator-5564', platform: 'android' });
    assert.equal(open.acquirable, true);
    assert.equal(entry?.acquirable, true);
  } finally {
    fs.rmSync(claimsDir, { recursive: true, force: true });
  }
});

test.skipIf(process.getuid?.() === 0)(
  'status and open agree that an unreadable claim root holds every device',
  async () => {
    const claimsDir = mkdtempForTestSync('agent-device-cli-claims-');
    try {
      fs.chmodSync(claimsDir, 0o000);
      const status = await statusDevices(claimsDir);
      const open = await openAdmissionFor(claimsDir, { id: 'emulator-5566', platform: 'android' });
      assert.equal(open.acquirable, false);
      // The root names no device, so status answers with the unreadable record, never acquirable.
      assert.deepEqual(status.devices, []);
      assert.deepEqual(
        status.claims.map((claim) => claim.classification),
        ['unknown'],
      );
    } finally {
      fs.chmodSync(claimsDir, 0o700);
      fs.rmSync(claimsDir, { recursive: true, force: true });
    }
  },
);

test('status and open name the host claim before the app claim', async () => {
  const claimsDir = mkdtempForTestSync('agent-device-cli-claims-');
  const ownerStateDir = mkdtempForTestSync('agent-device-cli-claims-owner-');
  const owner = readCurrentOwnerIdentity();
  try {
    const hostKey = 'local:web:none:chrome';
    const appId = 'chrome:app:com.example.app';
    const appKey = `local:web:none:${appId}`;
    fs.writeFileSync(
      path.join(claimsDir, `${cryptoHashForTest(hostKey)}.json`),
      claimJson({
        deviceKey: hostKey,
        id: 'chrome',
        platform: 'web',
        session: 'host-session',
        stateDir: process.cwd(),
        ownerPid: owner.pid,
        ownerStartTime: owner.startTime,
      }),
    );
    fs.writeFileSync(
      path.join(claimsDir, `${cryptoHashForTest(appKey)}.json`),
      claimJson({
        deviceKey: appKey,
        id: appId,
        platform: 'web',
        session: 'app-session',
        stateDir: ownerStateDir,
        ownerPid: 999_999_999,
        ownerStartTime: 'old-start-time',
      }),
    );
    // A dead app owner with an open recording would refuse on its own; the live host claim wins.
    screenRecordingDurableResource.store.write(
      screenRecordingDurableResource.store.resolvePath(
        path.join(ownerStateDir, 'sessions', 'app-session'),
      ),
      createDurableResourceEnvelope({
        resourceKind: 'screen-recording',
        sessionId: 'app-session',
        device: { id: appId, family: 'web', kind: 'device' },
        owner: localRuntimeOwner('web'),
        fence: { token: 'fence', generation: 1 },
        lifecycle: 'open',
        descriptor: { version: 1, body: {} },
      }),
    );

    const entry = (await statusDevices(claimsDir)).devices.find((d) => d.device.id === appId);
    const open = await openAdmissionFor(claimsDir, { id: appId, platform: 'web' });
    assert.equal(open.session, 'host-session');
    assert.equal(entry?.blockedBy, 'live-owner');
    assert.equal(entry?.owner?.session, 'host-session');
  } finally {
    fs.rmSync(claimsDir, { recursive: true, force: true });
    fs.rmSync(ownerStateDir, { recursive: true, force: true });
  }
});

function cryptoHashForTest(deviceKey: string): string {
  return crypto.createHash('sha256').update(deviceKey).digest('hex');
}

test('keeps corrupt claims visible and requires --stale for uncertain reclaimable views', async () => {
  const claimsDir = mkdtempForTestSync('agent-device-cli-claims-');
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
    fs.writeFileSync(
      path.join(claimsDir, 'pid-reused.json'),
      JSON.stringify({
        schemaVersion: 1,
        deviceKey: 'local:android:none:pid-reused',
        device: {
          platform: 'android',
          id: 'pid-reused',
          name: 'PID-reused Pixel',
          kind: 'emulator',
        },
        session: 'pid-reused-session',
        workspace: '/worktrees/pid-reused',
        stateDir: process.cwd(),
        ownerPid: owner.pid,
        ownerStartTime: 'different-readable-start-time',
        ownerToken: 'pid-reused-token',
        createdAtMs: 1,
        updatedAtMs: 1,
      }),
    );

    const normal = await runCliCapture(['device', 'status'], {
      env: { AGENT_DEVICE_CLAIMS_DIR: claimsDir },
    });
    assert.match(normal.stdout, /corrupt.json: inconsistent/);
    assert.doesNotMatch(normal.stdout, /State-dir-gone Pixel/);
    assert.doesNotMatch(normal.stdout, /PID-reused Pixel/);
    assert.match(normal.stdout, /2 stale claims hidden/);

    const stale = await runCliCapture(['device', 'status', '--stale'], {
      env: { AGENT_DEVICE_CLAIMS_DIR: claimsDir },
    });
    assert.match(stale.stdout, /State-dir-gone Pixel: owner-state-dir-gone/);
    assert.match(stale.stdout, /PID-reused Pixel: owner-process-reused/);
  } finally {
    fs.rmSync(claimsDir, { recursive: true, force: true });
  }
});

test('states that nothing is claimed when every claim is stale', async () => {
  // Regression: the all-stale case rendered only the hidden-claim notice, so a
  // user asking what holds a device saw a maintenance warning and no answer.
  const claimsDir = mkdtempForTestSync('agent-device-cli-claims-');
  try {
    fs.writeFileSync(
      path.join(claimsDir, 'stale.json'),
      JSON.stringify({
        schemaVersion: 1,
        deviceKey: 'local:apple:ios:stale-phone',
        device: { platform: 'ios', id: 'stale-phone', name: 'Dead iPhone', kind: 'device' },
        session: 'dead-session',
        workspace: '/worktrees/dead',
        stateDir: process.cwd(),
        ownerPid: 999_999_999,
        ownerStartTime: 'old-start-time',
        ownerToken: 'stale-token',
        createdAtMs: 1,
        updatedAtMs: 1,
      }),
    );

    const result = await runCliCapture(['device', 'status'], {
      env: { AGENT_DEVICE_CLAIMS_DIR: claimsDir },
    });

    assert.match(result.stdout, /No live local device claims found\./);
    assert.match(result.stdout, /1 stale claim hidden/);
    assert.doesNotMatch(result.stdout, /Dead iPhone/);
  } finally {
    fs.rmSync(claimsDir, { recursive: true, force: true });
  }
});

test('names a replaced-but-running daemon owner as stale rather than a live holder', async () => {
  const claimsDir = mkdtempForTestSync('agent-device-cli-claims-');
  const stateDir = path.join(claimsDir, 'state');
  try {
    // #2031: the recorded owner still runs, but we are the daemon published for
    // its state dir, so its session is one `session list` cannot report.
    publishDaemonRegistration(stateDir, readCurrentOwnerIdentity());
    fs.writeFileSync(
      path.join(claimsDir, 'superseded.json'),
      JSON.stringify({
        schemaVersion: 1,
        deviceKey: 'local:web:none:agent-browser-chrome',
        device: {
          platform: 'web',
          id: 'agent-browser-chrome',
          name: 'Chrome',
          kind: 'device',
        },
        session: 'cwd:/w:default',
        workspace: '/w',
        stateDir,
        ownerPid: process.ppid,
        ownerStartTime: null,
        ownerToken: 'superseded-token',
        createdAtMs: 1,
        updatedAtMs: 1,
      }),
    );

    const normal = await runCliCapture(['device', 'status'], {
      env: { AGENT_DEVICE_CLAIMS_DIR: claimsDir },
    });
    assert.match(normal.stdout, /No live local device claims found\./);
    assert.match(normal.stdout, /1 stale claim hidden/);

    const stale = await runCliCapture(['device', 'status', '--stale', '--json'], {
      env: { AGENT_DEVICE_CLAIMS_DIR: claimsDir },
    });
    const payload = JSON.parse(stale.stdout);
    assert.equal(payload.data.claims.length, 1);
    assert.equal(payload.data.claims[0].classification, 'owner-daemon-superseded');
    assert.equal(payload.data.claims[0].owner.session, 'cwd:/w:default');
  } finally {
    fs.rmSync(claimsDir, { recursive: true, force: true });
  }
});

// #4298: device status does not let a project agent-device.json udid override explicit --serial
test('device status matches explicit --serial when project agent-device.json sets a udid', async () => {
  const claimsDir = mkdtempForTestSync('agent-device-cli-claims-');
  const projectDir = mkdtempForTestSync('agent-device-project-dir-');
  const owner = readCurrentOwnerIdentity();
  try {
    fs.writeFileSync(
      path.join(projectDir, 'agent-device.json'),
      JSON.stringify({
        platform: 'ios',
        udid: '01234567-89AB-CDEF-0123-456789ABCDEF',
        session: 'ios-session',
      }),
    );
    fs.writeFileSync(
      path.join(claimsDir, 'android.json'),
      JSON.stringify({
        schemaVersion: 1,
        deviceKey: 'local:android:none:emulator-5560',
        device: {
          platform: 'android',
          id: 'emulator-5560',
          name: 'Android Emulator',
          kind: 'emulator',
        },
        session: 'android-session',
        workspace: '/worktrees/android',
        stateDir: process.cwd(),
        ownerPid: owner.pid,
        ownerStartTime: owner.startTime,
        ownerToken: 'android-token',
        createdAtMs: 1,
        updatedAtMs: 1,
      }),
    );

    const result = await runCliCapture(
      ['device', 'status', '--platform', 'android', '--serial', 'emulator-5560', '--json'],
      {
        cwd: projectDir,
        env: { AGENT_DEVICE_CLAIMS_DIR: claimsDir },
      },
    );
    assert.equal(result.code, null);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.success, true);
    assert.equal(payload.data.claims.length, 1);
    assert.equal(payload.data.claims[0].device.id, 'emulator-5560');
  } finally {
    fs.rmSync(claimsDir, { recursive: true, force: true });
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});

test('device status ignores AGENT_DEVICE_PLATFORM env default when platform is omitted', async () => {
  const claimsDir = mkdtempForTestSync('agent-device-cli-claims-');
  const owner = readCurrentOwnerIdentity();
  try {
    fs.writeFileSync(
      path.join(claimsDir, 'android.json'),
      JSON.stringify({
        schemaVersion: 1,
        deviceKey: 'local:android:none:emulator-5560',
        device: {
          platform: 'android',
          id: 'emulator-5560',
          name: 'Android Emulator',
          kind: 'emulator',
        },
        session: 'android-session',
        workspace: '/worktrees/android',
        stateDir: process.cwd(),
        ownerPid: owner.pid,
        ownerStartTime: owner.startTime,
        ownerToken: 'android-token',
        createdAtMs: 1,
        updatedAtMs: 1,
      }),
    );

    const result = await runCliCapture(
      ['device', 'status', '--serial', 'emulator-5560', '--json'],
      {
        env: {
          AGENT_DEVICE_CLAIMS_DIR: claimsDir,
          AGENT_DEVICE_PLATFORM: 'ios',
        },
      },
    );
    assert.equal(result.code, null);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.success, true);
    assert.equal(payload.data.claims.length, 1);
    assert.equal(payload.data.claims[0].device.id, 'emulator-5560');
  } finally {
    fs.rmSync(claimsDir, { recursive: true, force: true });
  }
});
