import assert from 'node:assert/strict';
import { test } from 'vitest';
import { isAudioProbeSupportedDevice } from '@agent-device/contracts/audio-probe-support';
import {
  resolveDeviceAppleOs,
  DEVICE_TARGETS,
  PLATFORMS,
  type DeviceInfo,
  type DeviceKind,
  type DeviceTarget,
} from '@agent-device/kernel/device';
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
} from '../test-utils/device-fixtures.ts';
import { getPlugin } from '../../core/platform-plugin-registry.ts';
import { registerBuiltinPlatformPlugins } from '../../core/interactors/register-builtins.ts';

// The equivalence gate for whatever Apple capability closures still exist. It began as the
// ADR-0009 step d.5 table-equivalence test, pinning closures that had been rewritten to read a
// per-`AppleOS` data table; R59 retired that table with its last reader (`alert`), so what
// remains are the two closures that were never table-driven. The shape of the check is unchanged:
// each closure on the Apple plugin must return an identical boolean / identical hint STRING to an
// INDEPENDENT verbatim copy of its contract, across the full {command x sample-device} matrix —
// real discovery shapes for iOS/iPadOS/tvOS/macOS/visionOS plus the exhaustive synthetic
// cross-product.

registerBuiltinPlatformPlugins();

// ---------------------------------------------------------------------------
// Independent copies of the command capability contracts. This oracle stays independent of the
// closures it pins (mirrors capability-plugin-routing-parity.test.ts).
// ---------------------------------------------------------------------------
const supportsCoreDevicePhysicalOperation = (device: DeviceInfo): boolean =>
  device.platform !== 'apple' ||
  device.kind !== 'device' ||
  device.iosPhysicalDeviceBackend !== 'xctest';
const coreDeviceOnlyPhysicalOperationHint = (device: DeviceInfo): string | undefined =>
  supportsCoreDevicePhysicalOperation(device)
    ? undefined
    : 'This command requires a CoreDevice-backed physical iOS device. The selected XCTest backend supports open, close, interactions, snapshots, and screenshots.';
// `home`/`keyboard`/`orientation`/`tv-remote` left with R42-R46, `clipboard` with R55,
// `app-switcher` with R56, `settings` with R58 and `alert` with R59 — each cutover retiring its
// AppleOS-table-reading closure along with its descriptor capability bucket. `alert` was the
// table's last reader, so the table went with it; per-AppleOS admission now lives as owner facts
// in `packages/platform-apple/src/runtime.ts` and its `system/`, `navigation/` siblings.
const SUPPORTS_REF: Record<string, (device: DeviceInfo) => boolean> = {
  perf: supportsCoreDevicePhysicalOperation,
  // `audio` was never part of the AppleOS-table relocation — it is the standalone
  // `isAudioProbeSupportedDevice` predicate. Included here so the key-set assertion stays strict
  // (it catches a dropped command) and confirms no rebase altered it.
  audio: isAudioProbeSupportedDevice,
};
const HINT_REF: Record<string, (device: DeviceInfo) => string | undefined> = {
  perf: coreDeviceOnlyPhysicalOperationHint,
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
  { ...IOS_DEVICE, id: 'xctest-ios-device', iosPhysicalDeviceBackend: 'xctest' },
  ...APPLE_FIXTURES.flatMap(withKinds),
  ...buildSyntheticMatrix(),
];

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

test('Apple supports() closures match the independent command contracts', () => {
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

test('Apple unsupportedHint() closures match the independent contracts', () => {
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
