import {
  ANDROID_DEVICE,
  ANDROID_EMULATOR,
  IOS_DEVICE,
  IOS_SIMULATOR,
  LINUX_DEVICE,
  MACOS_DEVICE,
  TVOS_SIMULATOR,
  WEB_DESKTOP_DEVICE,
} from '../../__tests__/test-utils/device-fixtures.ts';
import { SCREENSHOT_CROP_REASONS } from '@agent-device/contracts/capture';
import type { SessionSurface } from '@agent-device/contracts/session';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { expect, test } from 'vitest';
import {
  SCREENSHOT_CROP_TARGET_CELLS,
  assertScreenshotCropPolicy,
  classifyScreenshotCropTarget,
} from '../screenshot-crop-target.ts';

type CropTargetDevice = Readonly<{
  target: (typeof SCREENSHOT_CROP_TARGET_CELLS)[number]['target'];
  device: DeviceInfo;
  surface: SessionSurface | undefined;
}>;

/** One device per matrix cell: the classifier's whole reachable output, named by its cell. */
const CROP_TARGET_DEVICES: readonly CropTargetDevice[] = [
  { target: 'ios-simulator', device: IOS_SIMULATOR, surface: undefined },
  { target: 'android-emulator', device: ANDROID_EMULATOR, surface: undefined },
  { target: 'android-device', device: ANDROID_DEVICE, surface: undefined },
  { target: 'macos-app-window', device: MACOS_DEVICE, surface: 'app' },
  { target: 'ios-physical', device: IOS_DEVICE, surface: undefined },
  { target: 'macos-helper', device: MACOS_DEVICE, surface: undefined },
  { target: 'web', device: WEB_DESKTOP_DEVICE, surface: undefined },
  { target: 'linux', device: LINUX_DEVICE, surface: undefined },
  { target: 'tvos', device: TVOS_SIMULATOR, surface: undefined },
  {
    target: 'harmonyos',
    device: { platform: 'harmonyos', id: 'hmy-1', name: 'HarmonyOS', kind: 'device' },
    surface: undefined,
  },
  {
    target: 'vega',
    device: { platform: 'vega', id: 'vega-1', name: 'Vega TV', kind: 'device', target: 'tv' },
    surface: undefined,
  },
];

test('the classifier and the acceptance matrix agree one-to-one, and the accepted cells are exactly the evidenced ones', () => {
  const matrixTargets = SCREENSHOT_CROP_TARGET_CELLS.map((cell) => cell.target);
  expect(new Set(matrixTargets).size).toBe(matrixTargets.length);
  for (const row of CROP_TARGET_DEVICES) {
    expect(classifyScreenshotCropTarget(row.device, row.surface)).toBe(row.target);
  }
  expect(CROP_TARGET_DEVICES.map((row) => row.target)).toEqual(matrixTargets);
  for (const cell of SCREENSHOT_CROP_TARGET_CELLS) {
    if (cell.target === 'ios-simulator' || cell.target === 'android-emulator') {
      expect(cell.status).toBe('accepted');
    } else {
      expect(cell).toEqual({
        target: cell.target,
        status: 'rejected',
        rejectionReason: SCREENSHOT_CROP_REASONS.pendingPixelIdentityEvidence,
      });
    }
  }
});

test('an apple device with an unpopulated reserved OS is a typed refusal, not a guess', () => {
  const device: DeviceInfo = {
    platform: 'apple',
    id: 'watch-1',
    name: 'Watch',
    kind: 'simulator',
    appleOs: 'watchos',
  };
  let refusal: unknown;
  try {
    classifyScreenshotCropTarget(device, undefined);
  } catch (error) {
    refusal = error;
  }
  expect(refusal).toMatchObject({
    code: 'UNSUPPORTED_OPERATION',
    details: { reason: SCREENSHOT_CROP_REASONS.targetNotAccepted },
  });
});

function expectPolicyRefusal(
  params: Readonly<{
    device: DeviceInfo;
    surface: SessionSurface | undefined;
    cropOn: string;
    overlayRefs: boolean;
    fullscreen: boolean;
  }>,
  expected: Record<string, unknown>,
): void {
  try {
    assertScreenshotCropPolicy(params);
  } catch (error) {
    expect(error).toMatchObject(expected);
    return;
  }
  throw new Error('the crop policy must refuse before device work');
}

const POLICY_BASE = { cropOn: 'label="Save"', overlayRefs: false, fullscreen: false } as const;

test('combination refusals are answered before selector validation and the matrix', () => {
  expectPolicyRefusal(
    { device: MACOS_DEVICE, surface: 'app', ...POLICY_BASE, overlayRefs: true },
    { code: 'INVALID_ARGS', details: { reason: SCREENSHOT_CROP_REASONS.frameMismatch } },
  );
  expectPolicyRefusal(
    { device: ANDROID_EMULATOR, surface: undefined, ...POLICY_BASE, fullscreen: true },
    { code: 'INVALID_ARGS', details: { reason: SCREENSHOT_CROP_REASONS.frameMismatch } },
  );
});

test('an invalid selector expression is refused with the selector reason', () => {
  expectPolicyRefusal(
    {
      device: ANDROID_EMULATOR,
      surface: undefined,
      cropOn: 'label="unterminated',
      overlayRefs: false,
      fullscreen: false,
    },
    { code: 'INVALID_ARGS', details: { reason: SCREENSHOT_CROP_REASONS.selectorInvalid } },
  );
});

test('a matrix-rejected target is refused with the pending-evidence reason', () => {
  expectPolicyRefusal(
    { device: ANDROID_DEVICE, surface: undefined, ...POLICY_BASE },
    {
      code: 'UNSUPPORTED_OPERATION',
      details: {
        reason: SCREENSHOT_CROP_REASONS.targetNotAccepted,
        rejectionReason: SCREENSHOT_CROP_REASONS.pendingPixelIdentityEvidence,
      },
    },
  );
});

test('an accepted target with a valid selector passes the policy', () => {
  expect(() =>
    assertScreenshotCropPolicy({ device: ANDROID_EMULATOR, surface: undefined, ...POLICY_BASE }),
  ).not.toThrow();
});
