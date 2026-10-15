import { test } from 'vitest';
import assert from 'node:assert/strict';

import {
  APPLE_BIOMETRIC_LEAF_REFUSAL,
  APPLE_TEXT_SIZE_LEAF_REFUSAL,
  type AppleSettingLeafRefusal,
} from '@agent-device/contracts/settings';
import { AppError } from '@agent-device/kernel/errors';
import type { AppleOS, DeviceInfo } from '@agent-device/kernel/device';
import { requireHandheldAppleSimulatorLeaf } from '../settings-leaf.ts';
import {
  IOS_TEST_DEVICE,
  IOS_TEST_SIMULATOR,
  IPADOS_TEST_SIMULATOR,
  MACOS_TEST_DEVICE,
  TVOS_TEST_SIMULATOR,
  VISIONOS_TEST_SIMULATOR,
} from './apple-core-stub-helpers.ts';

const REFUSALS = [
  { setting: 'text-size', refusal: APPLE_TEXT_SIZE_LEAF_REFUSAL },
  { setting: 'biometric', refusal: APPLE_BIOMETRIC_LEAF_REFUSAL },
] as const;

/**
 * The leaf every iPhone/iPad-only settings surface lives on. iPhone arrives with `appleOs` inferred
 * from its target and iPad with it stored, so both readings of the predicate are exercised.
 */
const ADMITTED: readonly DeviceInfo[] = [IOS_TEST_SIMULATOR, IPADOS_TEST_SIMULATOR];

/** Every other Apple leaf, named with the OS the refusal has to report for it. */
const REFUSED: readonly { device: DeviceInfo; appleOs: AppleOS }[] = [
  { device: IOS_TEST_DEVICE, appleOs: 'ios' },
  { device: TVOS_TEST_SIMULATOR, appleOs: 'tvos' },
  { device: VISIONOS_TEST_SIMULATOR, appleOs: 'visionos' },
  { device: MACOS_TEST_DEVICE, appleOs: 'macos' },
];

for (const device of ADMITTED) {
  for (const { setting, refusal } of REFUSALS) {
    test(`requireHandheldAppleSimulatorLeaf admits ${device.name} for ${setting}`, () => {
      requireHandheldAppleSimulatorLeaf(device, refusal);
    });
  }
}

/**
 * A refusal carries the guard's whole report: the setting's own sentence and hint — the guard keeps
 * no prose of its own, which is what keeps two settings' hints distinct — beside the leaf that was
 * refused, so a machine consumer can tell a physical-device read failure from a tvOS one.
 */
function assertRefused(
  device: DeviceInfo,
  appleOs: AppleOS,
  refusal: AppleSettingLeafRefusal,
): void {
  assert.throws(
    () => requireHandheldAppleSimulatorLeaf(device, refusal),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, 'UNSUPPORTED_OPERATION');
      assert.equal(error.message, refusal.message);
      assert.deepEqual(error.details, {
        deviceId: device.id,
        appleOs,
        deviceKind: device.kind,
        reason: 'setting-unsupported-on-leaf',
        hint: refusal.hint,
      });
      return true;
    },
  );
}

for (const { device, appleOs } of REFUSED) {
  for (const { setting, refusal } of REFUSALS) {
    test(`requireHandheldAppleSimulatorLeaf refuses ${device.name} for ${setting}`, () => {
      assertRefused(device, appleOs, refusal);
    });
  }
}
