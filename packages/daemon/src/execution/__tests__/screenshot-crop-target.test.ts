import {
  ANDROID_DEVICE,
  ANDROID_EMULATOR,
  ANDROID_TV_DEVICE,
  IOS_DEVICE,
  IOS_SIMULATOR,
  IPADOS_SIMULATOR,
  LINUX_DEVICE,
  MACOS_DEVICE,
  TVOS_SIMULATOR,
  WEB_DESKTOP_DEVICE,
} from '@agent-device/test-kit';
import { SCREENSHOT_CROP_REASONS } from '@agent-device/contracts/capture';
import {
  SESSION_SURFACES,
  type MacOsSurfaceBackend,
  type SessionSurface,
} from '@agent-device/contracts/session';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { snapshotCaptureScaleFrom, snapshotViewportSizeFrom } from '@agent-device/kernel/rect';
import { afterEach, expect, test } from 'vitest';
import { makeProviderRuntimeOwning } from '../../__tests__/support/handlers/snapshot-handler.fixtures.ts';
import { providerDeviceAdmissionFixture } from '../../__tests__/support/provider-device-admission-fixture.ts';
import {
  SCREENSHOT_CROP_TARGET_CELLS,
  assertScreenshotCropPolicy,
  assertScreenshotCropSnapshot,
  classifyScreenshotCropTarget,
} from '../screenshot-crop-target.ts';

type CropTargetDevice = Readonly<{
  target: (typeof SCREENSHOT_CROP_TARGET_CELLS)[number]['target'];
  device: DeviceInfo;
  surface: SessionSurface | undefined;
}>;

const IPADOS_DEVICE: DeviceInfo = { ...IPADOS_SIMULATOR, kind: 'device' };
const IOS_DEVICE_COREDEVICE: DeviceInfo = {
  ...IOS_DEVICE,
  iosPhysicalDeviceBackend: 'coredevice',
};
const IOS_DEVICE_XCTEST: DeviceInfo = {
  ...IOS_DEVICE,
  iosPhysicalDeviceBackend: 'xctest',
};
const PROVIDER_TV: DeviceInfo = {
  platform: 'android',
  id: 'tizen:192.0.2.10:26101',
  name: '192.0.2.10',
  kind: 'device',
  target: 'tv',
  booted: true,
};
const TV_PROVIDER_RUNTIME = makeProviderRuntimeOwning(PROVIDER_TV, 'tizen');
const providerAdmission = providerDeviceAdmissionFixture([TV_PROVIDER_RUNTIME]);

afterEach(() => {
  providerAdmission.setActive([TV_PROVIDER_RUNTIME]);
});

/** The cells with live pixel-identity evidence; every other cell stays rejected. */
const ACCEPTED_CROP_TARGETS: readonly CropTargetDevice['target'][] = [
  'ios-simulator',
  'android-emulator',
  'provider-android-tv',
  'ios-physical',
];

/** One device per matrix cell: the classifier's whole reachable output, named by its cell. */
const CROP_TARGET_DEVICES: readonly CropTargetDevice[] = [
  { target: 'ios-simulator', device: IOS_SIMULATOR, surface: undefined },
  { target: 'android-emulator', device: ANDROID_EMULATOR, surface: undefined },
  { target: 'android-device', device: ANDROID_DEVICE, surface: undefined },
  { target: 'provider-android-tv', device: PROVIDER_TV, surface: undefined },
  { target: 'macos-app-window', device: MACOS_DEVICE, surface: 'app' },
  { target: 'ios-physical', device: IOS_DEVICE, surface: undefined },
  { target: 'ios-physical-xctest', device: IOS_DEVICE_XCTEST, surface: undefined },
  { target: 'ipados-physical', device: IPADOS_DEVICE, surface: undefined },
  { target: 'macos-helper', device: MACOS_DEVICE, surface: 'desktop' },
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
    if (ACCEPTED_CROP_TARGETS.includes(cell.target)) {
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

test('an Android TV is in the provider TV cell only while a provider runtime owns it', () => {
  expect(classifyScreenshotCropTarget(PROVIDER_TV, undefined)).toBe('provider-android-tv');
  expect(classifyScreenshotCropTarget(ANDROID_TV_DEVICE, undefined)).toBe('android-device');
  providerAdmission.setActive([]);
  expect(classifyScreenshotCropTarget(PROVIDER_TV, undefined)).toBe('android-device');
});

test('a provider-owned phone stays in the Android device cell', () => {
  providerAdmission.setActive([makeProviderRuntimeOwning(ANDROID_DEVICE)]);
  expect(classifyScreenshotCropTarget(ANDROID_DEVICE, undefined)).toBe('android-device');
});

test('a provider-owned Android TV emulator stays in the Android emulator cell', () => {
  const tvEmulator: DeviceInfo = { ...PROVIDER_TV, kind: 'emulator' };
  providerAdmission.setActive([makeProviderRuntimeOwning(tvEmulator)]);
  expect(classifyScreenshotCropTarget(tvEmulator, undefined)).toBe('android-emulator');
});

const TV_PAGE = {
  producer: 'cdp-dom',
  captureScale: snapshotCaptureScaleFrom(1.5),
  viewport: snapshotViewportSizeFrom({ x: 0, y: 0, width: 1280, height: 720 }),
} as const;

test('a provider TV crop is accepted only on the page tree the TV plugins capture', () => {
  expect(() => assertScreenshotCropSnapshot(PROVIDER_TV, TV_PAGE)).not.toThrow();
  expect(() =>
    assertScreenshotCropSnapshot(ANDROID_EMULATOR, { producer: 'android-uiautomator' }),
  ).not.toThrow();
  expect(() =>
    assertScreenshotCropSnapshot(PROVIDER_TV, { ...TV_PAGE, producer: 'android-uiautomator' }),
  ).toThrow(
    expect.objectContaining({
      code: 'UNSUPPORTED_OPERATION',
      message:
        'screenshot --crop-on is not accepted on provider-android-tv-non-cdp-snapshot targets',
      details: {
        reason: SCREENSHOT_CROP_REASONS.targetNotAccepted,
        rejectionReason: SCREENSHOT_CROP_REASONS.pendingPixelIdentityEvidence,
      },
    }),
  );
});

test('a provider TV crop fails on a page that published no capture scale or no viewport', () => {
  const unreadable = expect.objectContaining({
    code: 'COMMAND_FAILED',
    details: { reason: SCREENSHOT_CROP_REASONS.captureUnreadable },
  });
  expect(() =>
    assertScreenshotCropSnapshot(PROVIDER_TV, { ...TV_PAGE, captureScale: undefined }),
  ).toThrow(unreadable);
  expect(() =>
    assertScreenshotCropSnapshot(PROVIDER_TV, { ...TV_PAGE, viewport: undefined }),
  ).toThrow(unreadable);
});

test('a physical iPad has its own cell, and an iPad simulator stays in the simulator cell', () => {
  expect(classifyScreenshotCropTarget(IPADOS_DEVICE, undefined)).toBe('ipados-physical');
  expect(classifyScreenshotCropTarget(IPADOS_SIMULATOR, undefined)).toBe('ios-simulator');
});

test('a physical iPhone on CoreDevice passes the policy', () => {
  expect(classifyScreenshotCropTarget(IOS_DEVICE_COREDEVICE, undefined)).toBe('ios-physical');
  expect(() =>
    assertScreenshotCropPolicy({
      device: IOS_DEVICE_COREDEVICE,
      surface: undefined,
      cropOn: 'label="Continue"',
      overlayRefs: false,
      fullscreen: false,
    }),
  ).not.toThrow();
});

test('a physical iPhone on the XCTest backend is refused with the pending-evidence reason, naming its own cell', () => {
  expect(() =>
    assertScreenshotCropPolicy({
      device: IOS_DEVICE_XCTEST,
      surface: undefined,
      cropOn: 'label="Continue"',
      overlayRefs: false,
      fullscreen: false,
    }),
  ).toThrow(
    expect.objectContaining({
      code: 'UNSUPPORTED_OPERATION',
      message: 'screenshot --crop-on is not accepted on ios-physical-xctest targets',
      details: {
        reason: SCREENSHOT_CROP_REASONS.targetNotAccepted,
        rejectionReason: SCREENSHOT_CROP_REASONS.pendingPixelIdentityEvidence,
      },
    }),
  );
});

test('a physical iPad is refused with the pending-evidence reason, naming its own cell', () => {
  expect(() =>
    assertScreenshotCropPolicy({
      device: IPADOS_DEVICE,
      surface: undefined,
      cropOn: 'label="Continue"',
      overlayRefs: false,
      fullscreen: false,
    }),
  ).toThrow(
    expect.objectContaining({
      code: 'UNSUPPORTED_OPERATION',
      message: 'screenshot --crop-on is not accepted on ipados-physical targets',
      details: {
        reason: SCREENSHOT_CROP_REASONS.targetNotAccepted,
        rejectionReason: SCREENSHOT_CROP_REASONS.pendingPixelIdentityEvidence,
      },
    }),
  );
});

const MACOS_SURFACE_BACKENDS: Record<SessionSurface, MacOsSurfaceBackend> = {
  app: 'xctest',
  'frontmost-app': 'macos-helper',
  desktop: 'macos-helper',
  menubar: 'macos-helper',
};
const MACOS_CROP_TARGETS: Record<MacOsSurfaceBackend, CropTargetDevice['target']> = {
  xctest: 'macos-app-window',
  'macos-helper': 'macos-helper',
};

test.each([
  ...SESSION_SURFACES.map((surface) => [surface, MACOS_SURFACE_BACKENDS[surface]] as const),
  [undefined, 'xctest'] as const,
])('a macOS %s session crops in the frame of the backend that captures it', (surface, backend) => {
  expect(classifyScreenshotCropTarget(MACOS_DEVICE, surface)).toBe(MACOS_CROP_TARGETS[backend]);
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
  for (const device of [IOS_SIMULATOR, ANDROID_EMULATOR, PROVIDER_TV]) {
    expect(() =>
      assertScreenshotCropPolicy({ device, surface: undefined, ...POLICY_BASE }),
    ).not.toThrow();
  }
});
