import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, test } from 'vitest';
import * as hostProcess from '@agent-device/host-kit/process';
import { readCurrentOwnerIdentity } from '@agent-device/host-kit/process';
import { createDurableResourceEnvelope } from '@agent-device/capture-kit';
import { appLogResourceStore } from '@agent-device/capture-kit/app-log-durable-resource';
import { screenRecordingDurableResource } from '@agent-device/capture-kit/screen-recording-session-resource';
import { localRuntimeOwner } from '@agent-device/contracts/platform-runtime';
import { mkdtempForTestSync, pinOwnProcessStartTime } from '@agent-device/test-kit';
import { inspectDeviceAcquirability } from './device-claim-acquirability.ts';
import { canonicalLocalDeviceKey, resolveDeviceClaimPath } from './device-claim-paths.ts';
import { writeDeviceClaim } from './device-claim-store.ts';
import { inspectDeviceClaims, type DeviceClaim } from './device-claims.ts';
import { hostAppDeviceId, type DeviceIdentity } from '@agent-device/kernel/device';

pinOwnProcessStartTime(hostProcess);

const DEAD_OWNER_PID = 999_999_999;
const DEVICE: DeviceIdentity = { id: 'emulator-5554', family: 'android', kind: 'emulator' };

const roots: string[] = [];

afterEach(() => {
  delete process.env.AGENT_DEVICE_CLAIMS_DIR;
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function useClaimsRoot(): string {
  const root = mkdtempForTestSync('device-claim-acquirability-');
  roots.push(root);
  process.env.AGENT_DEVICE_CLAIMS_DIR = root;
  return root;
}

function claimFor(
  device: DeviceIdentity,
  owner: { pid: number; startTime: string | null },
  stateDir: string,
): DeviceClaim {
  return {
    schemaVersion: 3,
    deviceKey: canonicalLocalDeviceKey(device),
    device: { ...device, name: device.id },
    session: 'owner-session',
    workspace: '/worktrees/owner',
    stateDir,
    ownerPid: owner.pid,
    ownerStartTime: owner.startTime,
    ownerToken: 'owner-token',
    createdAtMs: 1,
    updatedAtMs: 1,
    claimOwnerKind: 'open-session',
  };
}

function deadClaim(device: DeviceIdentity = DEVICE, stateDir = process.cwd()): DeviceClaim {
  return claimFor(device, { pid: DEAD_OWNER_PID, startTime: 'old-start-time' }, stateDir);
}

function liveClaim(device: DeviceIdentity = DEVICE, stateDir = process.cwd()): DeviceClaim {
  return claimFor(device, readCurrentOwnerIdentity(), stateDir);
}

/** What `device status` answers for `device`: every stored claim, weighed by the same inspection. */
async function acquirabilityFor(device: DeviceIdentity) {
  return await inspectDeviceAcquirability({
    device,
    claims: inspectDeviceClaims({}, process.env),
    env: process.env,
  });
}

test('a live owner makes the device not acquirable and names that owner', async () => {
  useClaimsRoot();
  writeDeviceClaim(liveClaim(), process.env);

  const result = await acquirabilityFor(DEVICE);
  assert.equal(result.acquirable, false);
  assert.equal(result.blockedBy, 'live-owner');
  assert.equal(result.claim?.classification, 'live');
  assert.equal(result.claim?.session, 'owner-session');
});

test('a claim whose owner is provably dead and retains nothing is acquirable', async () => {
  const stateDir = useClaimsRoot();
  writeDeviceClaim(deadClaim(DEVICE, stateDir), process.env);

  const result = await acquirabilityFor(DEVICE);
  assert.equal(result.acquirable, true);
  assert.equal(result.blockedBy, undefined);
  assert.equal(result.claim?.classification, 'owner-process-dead');
});

test('a live claim of a host device blocks one of its app devices', async () => {
  useClaimsRoot();
  const host: DeviceIdentity = { id: 'chrome', family: 'web', kind: 'device' };
  const app: DeviceIdentity = { ...host, id: hostAppDeviceId(host.id, 'com.example.app') };
  writeDeviceClaim(liveClaim(host), process.env);

  const result = await acquirabilityFor(app);
  assert.equal(result.acquirable, false);
  assert.equal(result.blockedBy, 'live-owner');
});

test('a dead owner that still owns an open screen recording is not acquirable with that reason', async () => {
  const stateDir = useClaimsRoot();
  const claim = deadClaim(DEVICE, stateDir);
  writeDeviceClaim(claim, process.env);
  screenRecordingDurableResource.store.write(
    screenRecordingDurableResource.store.resolvePath(
      path.join(stateDir, 'sessions', claim.session),
    ),
    createDurableResourceEnvelope({
      resourceKind: 'screen-recording',
      sessionId: claim.session,
      device: claim.device,
      owner: localRuntimeOwner('android'),
      fence: { token: 'fence', generation: 1 },
      lifecycle: 'open',
      descriptor: { version: 1, body: {} },
    }),
  );

  const result = await acquirabilityFor(DEVICE);
  assert.equal(result.acquirable, false);
  assert.equal(result.blockedBy, 'screen-recording-cleanup-pending');
});

test('a dead owner whose recording reached its terminal state leaves the device acquirable', async () => {
  const stateDir = useClaimsRoot();
  const claim = deadClaim(DEVICE, stateDir);
  writeDeviceClaim(claim, process.env);
  appLogResourceStore.write(
    appLogResourceStore.resolvePath(path.join(stateDir, 'sessions', claim.session)),
    createDurableResourceEnvelope({
      resourceKind: 'app-log',
      sessionId: claim.session,
      device: claim.device,
      owner: localRuntimeOwner('android'),
      fence: { token: 'fence', generation: 1 },
      lifecycle: 'completed',
      descriptor: { version: 1, body: { pid: 123 } },
    }),
  );

  assert.equal((await acquirabilityFor(DEVICE)).acquirable, true);
});

test('unreadable resource evidence blocks a dead owner with its own reason', async () => {
  const stateDir = useClaimsRoot();
  const claim = deadClaim(DEVICE, stateDir);
  writeDeviceClaim(claim, process.env);
  const resourcePath = appLogResourceStore.resolvePath(
    path.join(stateDir, 'sessions', claim.session),
  );
  fs.mkdirSync(path.dirname(resourcePath), { recursive: true });
  fs.writeFileSync(resourcePath, '{');

  const result = await acquirabilityFor(DEVICE);
  assert.equal(result.acquirable, false);
  assert.equal(result.blockedBy, 'app-log-descriptor-invalid');
});

test('an unreadable claim record blocks the device its key points at, not another one', async () => {
  useClaimsRoot();
  fs.writeFileSync(resolveDeviceClaimPath(canonicalLocalDeviceKey(DEVICE), process.env), '{bad');

  const blocked = await acquirabilityFor(DEVICE);
  assert.equal(blocked.acquirable, false);
  assert.equal(blocked.blockedBy, 'claim-record-inconsistent');

  const other: DeviceIdentity = { id: 'emulator-5556', family: 'android', kind: 'emulator' };
  assert.deepEqual(await acquirabilityFor(other), { acquirable: true });
});

test('a device no claim names is acquirable', async () => {
  useClaimsRoot();
  writeDeviceClaim(deadClaim(), process.env);
  const other: DeviceIdentity = { id: 'emulator-5556', family: 'android', kind: 'emulator' };

  assert.deepEqual(await acquirabilityFor(other), { acquirable: true });
});
