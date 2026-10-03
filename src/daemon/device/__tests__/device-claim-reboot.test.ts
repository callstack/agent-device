import assert from 'node:assert/strict';
import { test } from 'vitest';
import type {
  DeviceBootObservation,
  DeviceBootObservationService,
} from '@agent-device/contracts/device-boot';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { rebootedDeviceClaim } from '../device-claim-reboot.ts';
import type { DeviceClaim } from '../device-claim-record.ts';

const device: DeviceInfo = {
  platform: 'apple',
  id: 'SIM-1',
  name: 'iPhone 17 Pro',
  kind: 'simulator',
  appleOs: 'ios',
  booted: true,
};

const CLAIM: DeviceClaim = {
  schemaVersion: 2,
  deviceKey: 'local:apple:ios:SIM-1',
  device: { family: 'apple', id: device.id, name: device.name, kind: device.kind },
  session: 'cwd:/w:default',
  workspace: '/w',
  stateDir: '/state/owner',
  ownerPid: 4242,
  ownerStartTime: 'start',
  ownerToken: 'token',
  createdAtMs: 1_000,
  updatedAtMs: 1_000,
};

function observes(answer: DeviceBootObservation): DeviceBootObservationService {
  return { observeBootTimeMs: async () => answer };
}

test('a device that came up after the claim destroyed what the claim was asserting', async () => {
  const tookOver = await rebootedDeviceClaim({
    claim: CLAIM,
    device,
    observeDeviceBoot: observes({ observed: true, bootedAtMs: 1_001 }),
  });

  assert.deepEqual(tookOver, {
    session: 'cwd:/w:default',
    workspace: '/w',
    stateDir: '/state/owner',
    bootedAtMs: 1_001,
  });
});

test('a boot the claim already covers proves nothing', async () => {
  for (const bootedAtMs of [CLAIM.updatedAtMs, CLAIM.updatedAtMs - 1]) {
    assert.equal(
      await rebootedDeviceClaim({
        claim: CLAIM,
        device,
        observeDeviceBoot: observes({ observed: true, bootedAtMs }),
      }),
      undefined,
      String(bootedAtMs),
    );
  }
});

test('a claim its owner renewed after the boot describes that boot', async () => {
  assert.equal(
    await rebootedDeviceClaim({
      claim: { ...CLAIM, updatedAtMs: 5_000 },
      device,
      observeDeviceBoot: observes({ observed: true, bootedAtMs: 1_001 }),
    }),
    undefined,
  );
});

test('an unanswered boot question leaves the claim exactly as protected as it was', async () => {
  const unanswered: DeviceBootObservation[] = [
    { observed: false, reason: 'unobserved' },
    { observed: false, reason: 'unsupported-device' },
  ];
  for (const answer of unanswered) {
    assert.equal(
      await rebootedDeviceClaim({ claim: CLAIM, device, observeDeviceBoot: observes(answer) }),
      undefined,
    );
  }
  assert.equal(await rebootedDeviceClaim({ claim: CLAIM, device }), undefined);
});
