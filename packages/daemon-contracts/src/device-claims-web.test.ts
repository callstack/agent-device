import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, test, vi } from 'vitest';
import {
  acquireDeviceClaim as acquireProductionDeviceClaim,
  inspectDeviceClaimAcquisition,
} from './device-claims.ts';
import { resolveDeviceClaimPath } from './device-claim-paths.ts';
import { webSessionDevice, type DeviceInfo } from '@agent-device/kernel/device';
import { mkdtempForTestSync, pinOwnProcessStartTime } from '@agent-device/test-kit';
import * as hostProcess from '@agent-device/host-kit/process';

pinOwnProcessStartTime(hostProcess);

const roots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.AGENT_DEVICE_CLAIMS_DIR;
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function useClaimsRoot(): string {
  const root = mkdtempForTestSync('agent-device-claims-web-');
  roots.push(root);
  process.env.AGENT_DEVICE_CLAIMS_DIR = root;
  return root;
}

const browser: DeviceInfo = {
  platform: 'web',
  id: 'agent-browser-chrome',
  name: 'Agent Browser Chrome',
  kind: 'device',
  target: 'desktop',
  booted: true,
};
const sessionOne = webSessionDevice(browser, { name: 'one' });
const sessionTwo = webSessionDevice(browser, { name: 'two' });

function acquire(device: DeviceInfo, stateDir: string) {
  return acquireProductionDeviceClaim({
    device,
    session: 'claimant',
    workspace: '/claimant',
    stateDir,
    env: process.env,
    reconcileOrphanedDeviceClaim: async () => ({ status: 'retained', reason: 'test-no-recovery' }),
  });
}

/** A claim of `device` that another live process owns, as a second daemon on the host would. */
async function seedForeignClaim(root: string, device: DeviceInfo): Promise<void> {
  const stateDir = path.join(root, `foreign-${device.id.replaceAll(':', '-')}`);
  fs.mkdirSync(stateDir, { recursive: true });
  const seeded = await acquire(device, stateDir);
  assert.equal(seeded.status, 'acquired');
  if (seeded.status !== 'acquired') throw new Error('seed failed');
  const file = resolveDeviceClaimPath(seeded.ownership.deviceKey, process.env);
  const stored = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
  fs.writeFileSync(
    file,
    JSON.stringify({ ...stored, ownerPid: process.ppid, ownerStartTime: null }),
  );
}

test('a live host claim refuses the claim of a web session device', async () => {
  const root = useClaimsRoot();
  await seedForeignClaim(root, browser);

  const result = await acquire(sessionOne, root);

  assert.equal(result.status, 'conflict');
  if (result.status !== 'conflict') return;
  assert.equal(result.conflict.claim?.device.id, browser.id);
});

test('a host acquisition refuses a live claim of one of its web session devices', async () => {
  const root = useClaimsRoot();
  await seedForeignClaim(root, sessionOne);

  const result = await acquire(browser, root);

  assert.equal(result.status, 'conflict');
  if (result.status !== 'conflict') return;
  assert.equal(result.conflict.claim?.device.id, sessionOne.id);
});

test('two web session devices of one host are claimed side by side', async () => {
  const root = useClaimsRoot();
  await seedForeignClaim(root, sessionOne);

  const result = await acquire(sessionTwo, root);

  assert.equal(result.status, 'acquired');
});

test('the acquisition preview of a web session device names the live host claim', async () => {
  const root = useClaimsRoot();
  await seedForeignClaim(root, browser);

  const settlements = await inspectDeviceClaimAcquisition({
    device: sessionOne,
    command: 'open',
    session: 'claimant',
    workspace: '/claimant',
    stateDir: root,
    env: process.env,
    coveredClaimIsOwnedByRequest: () => false,
  });

  assert.equal(
    settlements.some((settlement) => settlement.status === 'conflict'),
    true,
  );
});
