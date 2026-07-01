import assert from 'node:assert/strict';
import { test } from 'vitest';
import { isAudioProbeSupportedDevice } from '../../../kernel/audio-probe-support.ts';
import {
  isIosFamily,
  isMacOs,
  DEVICE_TARGETS,
  PLATFORMS,
  type AppleOS,
  type DeviceInfo,
  type DeviceKind,
  type DeviceTarget,
} from '../../../kernel/device.ts';
import {
  ANDROID_EMULATOR,
  ANDROID_TV_DEVICE,
  IOS_DEVICE,
  IOS_SIMULATOR,
  IPADOS_SIMULATOR,
  LINUX_DEVICE,
  MACOS_DEVICE,
  TVOS_SIMULATOR,
  VISIONOS_SIMULATOR,
  WEB_DESKTOP_DEVICE,
} from '../../../__tests__/test-utils/index.ts';
import { APPLE_OS_CAPABILITIES, resolveDeviceAppleOs } from '../apple-os-capabilities.ts';
import { getPlugin } from '../plugin.ts';
import { registerBuiltinPlatformPlugins } from '../../interactors/register-builtins.ts';

// Phase 3 step d.5 table-equivalence gate. The AppleOS-axis predicates
// (`target !== 'tv'` / `platform !== 'macos'` / `isTvOsDevice`) that used to be
// open-coded in the Apple capability closures now READ the per-`AppleOS` data table
// (`apple-os-capabilities.ts`). This test pins that the swap is byte-for-byte
// behaviorless: the closures now living on the Apple plugin return an identical
// boolean / identical hint STRING to an INDEPENDENT verbatim copy of the ORIGINAL
// predicates, across the full {command x sample-device} matrix — real discovery shapes
// for iOS/iPadOS/tvOS/macOS/visionOS plus the exhaustive synthetic cross-product.

registerBuiltinPlatformPlugins();

// ---------------------------------------------------------------------------
// Independent VERBATIM copies of the ORIGINAL command-facet predicates (before the
// table read), kept BYTE-FOR-BYTE by hand so this oracle stays INDEPENDENT of the
// table it pins (mirrors the copy in capability-plugin-routing-parity.test.ts).
// ---------------------------------------------------------------------------
const isNotMacOs = (device: DeviceInfo): boolean => !isMacOs(device);
const isMacOsOrAppleSimulator = (device: DeviceInfo): boolean =>
  isMacOs(device) || device.kind === 'simulator';
const isIosMobileSimulator = (device: DeviceInfo): boolean =>
  isIosFamily(device) && device.kind === 'simulator' && device.target !== 'tv';
const supportsSynthesisGesture = (device: DeviceInfo): boolean =>
  device.platform === 'android' || isIosMobileSimulator(device);
const supportsAndroidOrIosNonTv = (device: DeviceInfo): boolean =>
  device.platform === 'android' || (isIosFamily(device) && device.target !== 'tv');
const synthesisGestureUnsupportedHint = (device: DeviceInfo): string | undefined => {
  if (isMacOs(device))
    return 'macOS automation has no multi-touch input — this gesture is supported on Android and the iOS simulator only.';
  if (isIosFamily(device) && device.target === 'tv')
    return 'tvOS has no touch input — this gesture is supported on Android and the iOS simulator only.';
  if (isIosFamily(device) && device.kind === 'device')
    return 'Two-finger gesture synthesis is iOS-simulator only — not available on physical iOS devices.';
  return undefined;
};

const SUPPORTS_REF: Record<string, (device: DeviceInfo) => boolean> = {
  boot: isNotMacOs,
  install: isNotMacOs,
  reinstall: isNotMacOs,
  'install-from-source': isNotMacOs,
  push: isNotMacOs,
  home: isNotMacOs,
  'app-switcher': isNotMacOs,
  clipboard: (device) =>
    device.platform === 'android' ||
    device.platform === 'linux' ||
    isMacOs(device) ||
    device.kind === 'simulator',
  keyboard: supportsAndroidOrIosNonTv,
  rotate: supportsAndroidOrIosNonTv,
  alert: (device) => device.platform === 'android' || isMacOsOrAppleSimulator(device),
  settings: (device) =>
    device.platform === 'android' || isMacOs(device) || device.kind === 'simulator',
  // `audio` is NOT part of the AppleOS-table relocation — it stays the standalone
  // `isAudioProbeSupportedDevice` predicate. Included here only so the key-set
  // assertion stays strict (catches a dropped command) and confirms the rebase
  // did not alter it.
  audio: isAudioProbeSupportedDevice,
  pinch: supportsSynthesisGesture,
  'rotate-gesture': supportsSynthesisGesture,
  'transform-gesture': supportsSynthesisGesture,
};
const HINT_REF: Record<string, (device: DeviceInfo) => string | undefined> = {
  pinch: synthesisGestureUnsupportedHint,
  'rotate-gesture': synthesisGestureUnsupportedHint,
  'transform-gesture': synthesisGestureUnsupportedHint,
};

// ---------------------------------------------------------------------------
// The sample-device matrix: the real discovery fixtures (incl. the appleOs-bearing
// iPadOS/visionOS shapes, so the table's stored-`appleOs` read path is exercised) plus
// per-kind clones of every Apple fixture (so the physical-device paths run per OS) plus
// the exhaustive synthetic cross-product (the target-inference read path).
// ---------------------------------------------------------------------------
const APPLE_FIXTURES: DeviceInfo[] = [
  IOS_SIMULATOR,
  IOS_DEVICE,
  IPADOS_SIMULATOR,
  VISIONOS_SIMULATOR,
  TVOS_SIMULATOR,
  MACOS_DEVICE,
];

function withKinds(device: DeviceInfo): DeviceInfo[] {
  const kinds: DeviceKind[] = ['simulator', 'device'];
  return kinds.map((kind) => ({ ...device, kind, id: `${device.id}-${kind}` }));
}

const DEVICE_KINDS_ALL: DeviceKind[] = ['simulator', 'emulator', 'device'];
const DEVICE_TARGETS_ALL: (DeviceTarget | undefined)[] = [undefined, ...DEVICE_TARGETS];

function buildSyntheticMatrix(): DeviceInfo[] {
  const devices: DeviceInfo[] = [];
  for (const platform of PLATFORMS) {
    for (const kind of DEVICE_KINDS_ALL) {
      for (const target of DEVICE_TARGETS_ALL) {
        devices.push({
          platform,
          id: `${platform}-${kind}-${target ?? 'none'}`,
          name: `${platform} ${kind} ${target ?? 'none'}`,
          kind,
          ...(target ? { target } : {}),
          booted: true,
        });
      }
    }
  }
  return devices;
}

const SAMPLE_DEVICES: DeviceInfo[] = [
  ANDROID_EMULATOR,
  ANDROID_TV_DEVICE,
  LINUX_DEVICE,
  WEB_DESKTOP_DEVICE,
  ...APPLE_FIXTURES,
  ...APPLE_FIXTURES.flatMap(withKinds),
  ...buildSyntheticMatrix(),
];

test('the per-AppleOS table row keys are exhaustive and iOS/iPadOS/visionOS share one row', () => {
  const rows: AppleOS[] = ['ios', 'ipados', 'tvos', 'watchos', 'visionos', 'macos'];
  for (const os of rows) {
    assert.ok(APPLE_OS_CAPABILITIES[os], `capability row present for ${os}`);
  }
  // The iOS family is capability-identical today; sharing ONE frozen row is the
  // invariant that makes a stored `appleOs: 'ipados' | 'visionos'` read exactly what
  // the legacy target-inference produced for an unlabeled iOS record.
  assert.equal(APPLE_OS_CAPABILITIES.ios, APPLE_OS_CAPABILITIES.ipados);
  assert.equal(APPLE_OS_CAPABILITIES.ios, APPLE_OS_CAPABILITIES.visionos);
});

test('resolveDeviceAppleOs prefers the stored discriminant, else infers from target', () => {
  // Stored `appleOs` wins.
  assert.equal(resolveDeviceAppleOs(IPADOS_SIMULATOR), 'ipados');
  assert.equal(resolveDeviceAppleOs(VISIONOS_SIMULATOR), 'visionos');
  // Inference fallback for the fixtures that predate `appleOs`.
  assert.equal(resolveDeviceAppleOs(IOS_SIMULATOR), 'ios');
  assert.equal(resolveDeviceAppleOs(IOS_DEVICE), 'ios');
  assert.equal(resolveDeviceAppleOs(TVOS_SIMULATOR), 'tvos');
  assert.equal(resolveDeviceAppleOs(MACOS_DEVICE), 'macos');
});

test('table-driven Apple supports() closures are byte-for-byte the verbatim originals', () => {
  const appleSupports = getPlugin('apple').capability.supportsByDefault;
  assert.ok(appleSupports, 'the Apple plugin carries supportsByDefault');
  // Every command that had an original predicate must still carry one, keyed the same.
  assert.deepEqual(Object.keys(appleSupports).sort(), Object.keys(SUPPORTS_REF).sort());
  for (const [command, reference] of Object.entries(SUPPORTS_REF)) {
    const relocated: ((device: DeviceInfo) => boolean) | undefined = appleSupports[command];
    assert.ok(relocated, `${command} supports closure present on the Apple plugin`);
    for (const device of SAMPLE_DEVICES) {
      assert.equal(
        relocated(device),
        reference(device),
        `${command} supports on ${device.id} (appleOs=${device.appleOs ?? 'inferred'})`,
      );
    }
  }
});

test('table-driven Apple unsupportedHint() closures are byte-for-byte the verbatim originals', () => {
  const appleHints = getPlugin('apple').capability.unsupportedHintByDefault;
  assert.ok(appleHints, 'the Apple plugin carries unsupportedHintByDefault');
  assert.deepEqual(Object.keys(appleHints).sort(), Object.keys(HINT_REF).sort());
  for (const [command, reference] of Object.entries(HINT_REF)) {
    const relocated: ((device: DeviceInfo) => string | undefined) | undefined = appleHints[command];
    assert.ok(relocated, `${command} hint closure present on the Apple plugin`);
    for (const device of SAMPLE_DEVICES) {
      assert.equal(
        relocated(device),
        reference(device),
        `${command} hint on ${device.id} (appleOs=${device.appleOs ?? 'inferred'})`,
      );
    }
  }
});
