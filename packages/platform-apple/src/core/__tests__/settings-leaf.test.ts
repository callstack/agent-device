import { test } from 'vitest';
import assert from 'node:assert/strict';

import { AppError } from '@agent-device/kernel/errors';
import {
  APPLE_BIOMETRIC_LEAF_REFUSAL,
  APPLE_TEXT_SIZE_LEAF_REFUSAL,
} from '@agent-device/contracts/settings';
import { requireHandheldAppleSimulatorLeaf } from '../settings-leaf.ts';
import { assertThrowsAppError } from '../../__tests__/app-error.ts';
import {
  IOS_TEST_SIMULATOR,
  MACOS_TEST_DEVICE,
  TVOS_TEST_SIMULATOR,
} from './apple-core-stub-helpers.ts';

test('requireHandheldAppleSimulatorLeaf accepts the iPhone/iPad simulator leaf', () => {
  requireHandheldAppleSimulatorLeaf(IOS_TEST_SIMULATOR, APPLE_TEXT_SIZE_LEAF_REFUSAL);
});

test('requireHandheldAppleSimulatorLeaf throws the refusal it was given', () => {
  assertThrowsAppError(
    () => requireHandheldAppleSimulatorLeaf(TVOS_TEST_SIMULATOR, APPLE_BIOMETRIC_LEAF_REFUSAL),
    {
      code: 'UNSUPPORTED_OPERATION',
      message: /Face ID and Touch ID simulation is supported on iOS and iPadOS simulators/,
      hint: APPLE_BIOMETRIC_LEAF_REFUSAL.hint,
    },
  );
});

test('requireHandheldAppleSimulatorLeaf reports the leaf that was refused', () => {
  try {
    requireHandheldAppleSimulatorLeaf(MACOS_TEST_DEVICE, APPLE_TEXT_SIZE_LEAF_REFUSAL);
    assert.fail('expected the macOS host to be refused');
  } catch (error) {
    assert.ok(error instanceof AppError);
    assert.deepEqual(error.details, {
      deviceId: MACOS_TEST_DEVICE.id,
      appleOs: 'macos',
      deviceKind: 'device',
      reason: APPLE_TEXT_SIZE_LEAF_REFUSAL.reason,
      hint: APPLE_TEXT_SIZE_LEAF_REFUSAL.hint,
    });
  }
});
