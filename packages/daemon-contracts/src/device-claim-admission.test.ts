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
import { inspectNewSessionAdmission } from './device-claim-admission.ts';
import { canonicalLocalDeviceKey, resolveDeviceClaimPath } from './device-claim-paths.ts';
import { writeDeviceClaim } from './device-claim-store.ts';
import { deviceClaimRefusalReason, type DeviceClaim } from './device-claims.ts';
import { hostAppDeviceId, type DeviceIdentity, type DeviceInfo } from '@agent-device/kernel/device';

pinOwnProcessStartTime(hostProcess);

const DEAD_OWNER_PID = 999_999_999;
const DEVICE: DeviceIdentity = { id: 'emulator-5554', family: 'android', kind: 'emulator' };

const roots: string[] = [];

afterEach(() => {
  delete process.env.AGENT_DEVICE_CLAIMS_DIR;
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function useClaimsRoot(): string {
  const root = mkdtempForTestSync('device-claim-admission-');
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

function infoOf(device: DeviceIdentity): DeviceInfo {
  const { family, ...rest } = device;
  return { ...rest, platform: family, name: device.id };
}

/** What `device status` asks: the admission verdict of a new session of a daemon holding nothing. */
async function admissionFor(device: DeviceIdentity) {
  return await inspectNewSessionAdmission({ device: infoOf(device), env: process.env });
}

function refusedReason(admission: Awaited<ReturnType<typeof admissionFor>>): string | undefined {
  if (admission.status !== 'refused') return undefined;
  return admission.retainedBy ?? deviceClaimRefusalReason(admission.conflict.classification);
}

test('a live owner refuses the device and names that owner', async () => {
  useClaimsRoot();
  writeDeviceClaim(liveClaim(), process.env);

  const result = await admissionFor(DEVICE);
  assert.equal(result.status, 'refused');
  assert.equal(refusedReason(result), 'live-owner');
  assert.equal(result.status === 'refused' && result.conflict.claim?.session, 'owner-session');
});

test('a claim whose owner is provably dead and retains nothing is admitted', async () => {
  const stateDir = useClaimsRoot();
  writeDeviceClaim(deadClaim(DEVICE, stateDir), process.env);

  const result = await admissionFor(DEVICE);
  assert.equal(result.status, 'admitted');
  assert.equal(result.status === 'admitted' && result.reclaimed[0]?.claim.session, 'owner-session');
});

test('a live claim of a host device refuses one of its app devices', async () => {
  useClaimsRoot();
  const host: DeviceIdentity = { id: 'chrome', family: 'web', kind: 'device' };
  const app: DeviceIdentity = { ...host, id: hostAppDeviceId(host.id, 'com.example.app') };
  writeDeviceClaim(liveClaim(host), process.env);

  assert.equal(refusedReason(await admissionFor(app)), 'live-owner');
});

test('a dead owner whose recording is still open is admitted with the recovery it needs', async () => {
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

  const result = await admissionFor(DEVICE);
  assert.equal(result.status, 'admitted');
  const recovery = result.status === 'admitted' ? result.reclaimed[0]?.recovery : undefined;
  assert.deepEqual(recovery?.status === 'inspectable' && recovery.recoveryKinds, [
    'screen-recording',
  ]);
});

test('a dead owner whose resource reached its terminal state needs no recovery', async () => {
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

  const result = await admissionFor(DEVICE);
  const recovery = result.status === 'admitted' ? result.reclaimed[0]?.recovery : undefined;
  assert.deepEqual(recovery?.status === 'inspectable' && recovery.recoveryKinds, []);
});

test('unreadable resource evidence refuses a dead owner with its own reason', async () => {
  const stateDir = useClaimsRoot();
  const claim = deadClaim(DEVICE, stateDir);
  writeDeviceClaim(claim, process.env);
  const resourcePath = appLogResourceStore.resolvePath(
    path.join(stateDir, 'sessions', claim.session),
  );
  fs.mkdirSync(path.dirname(resourcePath), { recursive: true });
  fs.writeFileSync(resourcePath, '{');

  assert.equal(refusedReason(await admissionFor(DEVICE)), 'app-log-descriptor-invalid');
});

test('an unreadable claim record refuses the device its key points at, not another one', async () => {
  useClaimsRoot();
  fs.writeFileSync(resolveDeviceClaimPath(canonicalLocalDeviceKey(DEVICE), process.env), '{bad');

  assert.equal(refusedReason(await admissionFor(DEVICE)), 'claim-record-inconsistent');
  const other: DeviceIdentity = { id: 'emulator-5556', family: 'android', kind: 'emulator' };
  assert.deepEqual(await admissionFor(other), { status: 'admitted', reclaimed: [] });
});

test('a device no claim names is admitted', async () => {
  useClaimsRoot();
  writeDeviceClaim(deadClaim(), process.env);
  const other: DeviceIdentity = { id: 'emulator-5556', family: 'android', kind: 'emulator' };

  assert.deepEqual(await admissionFor(other), { status: 'admitted', reclaimed: [] });
});
