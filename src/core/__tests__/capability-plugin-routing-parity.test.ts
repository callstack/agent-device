import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  DEVICE_TARGETS,
  PLATFORMS,
  type DeviceInfo,
  type DeviceKind,
  type DeviceTarget,
} from '../../kernel/device.ts';
import {
  ANDROID_EMULATOR,
  ANDROID_TV_DEVICE,
  IOS_DEVICE,
  IOS_SIMULATOR,
  LINUX_DEVICE,
  MACOS_DEVICE,
  TVOS_SIMULATOR,
  WEB_DESKTOP_DEVICE,
} from '../../__tests__/test-utils/index.ts';
import {
  BASE_COMMAND_CAPABILITY_MATRIX,
  isCommandSupportedOnDevice,
  listCapabilityCommands,
  unsupportedHintForDevice,
  type CommandCapability,
} from '../capabilities.ts';
import { deriveCapabilityForPlatform } from '../platform-descriptor/derive.ts';
import { platformDescriptors } from '../platform-descriptor/registry.ts';
import { getPlugin } from '../platform-plugin/plugin.ts';
import { registerBuiltinPlatformPlugins } from '../platform-plugin/register-builtins.ts';

// Phase 3 step (b) parity gate. Two independent oracles pin that the migration is
// byte-for-byte behaviorless:
//   (b.1) the platform -> capability-bucket selection in `isCommandSupportedOnDevice`
//         now flows through the PlatformPlugin registry instead of the
//         `platformDescriptors` fold. `deriveCapabilityForPlatform(platformDescriptors,
//         ...)` is kept here as the BEFORE-derivation oracle (the production fold was
//         deleted), so a plugin-vs-descriptor disagreement fails this test.
//   (b.2) the per-command `supports()` / `unsupportedHint()` closures stay VERBATIM on
//         the command-descriptor facet (they cannot move to the plugin's per-FAMILY
//         `capability.supportsByDefault` without flattening their per-command shape —
//         perfect-shape §7). Independent verbatim copies below pin that the closures,
//         as they flow through `deriveCapabilityMatrix` into admission, are unchanged
//         across the full {platform x command x device-kind x target} matrix.

registerBuiltinPlatformPlugins();

// --- the exhaustive synthetic device matrix (every platform x kind x target) ---
const DEVICE_KINDS_ALL: DeviceKind[] = ['simulator', 'emulator', 'device'];
const DEVICE_TARGETS_ALL: (DeviceTarget | undefined)[] = [undefined, ...DEVICE_TARGETS];

function buildDeviceMatrix(): DeviceInfo[] {
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

// The hand-authored fixtures (reused per the plan) plus the exhaustive synthetic
// cross-product, so the real discovery shapes AND every off-nominal combination
// (e.g. a linux simulator, a macOS emulator) are pinned.
const SAMPLE_DEVICES: DeviceInfo[] = [
  ANDROID_EMULATOR,
  ANDROID_TV_DEVICE,
  IOS_DEVICE,
  IOS_SIMULATOR,
  LINUX_DEVICE,
  MACOS_DEVICE,
  TVOS_SIMULATOR,
  WEB_DESKTOP_DEVICE,
  ...buildDeviceMatrix(),
];

// ---------------------------------------------------------------------------
// (b.2) Independent VERBATIM copies of the per-command supports()/unsupportedHint()
// closures (src/core/command-descriptor/registry.ts). Kept BYTE-FOR-BYTE in sync by
// hand so this oracle stays INDEPENDENT of the descriptor it pins (mirrors the
// `selectCapabilityByHandSwitch` copy in platform-descriptor/__tests__/parity.test.ts).
// ---------------------------------------------------------------------------
const isNotMacOs = (device: DeviceInfo): boolean => device.platform !== 'macos';
const isMacOsOrAppleSimulator = (device: DeviceInfo): boolean =>
  device.platform === 'macos' || device.kind === 'simulator';
const isIosMobileSimulator = (device: DeviceInfo): boolean =>
  device.platform === 'ios' && device.kind === 'simulator' && device.target !== 'tv';
const supportsSynthesisGesture = (device: DeviceInfo): boolean =>
  device.platform === 'android' || isIosMobileSimulator(device);
const supportsAndroidOrIosNonTv = (device: DeviceInfo): boolean =>
  device.platform === 'android' || (device.platform === 'ios' && device.target !== 'tv');
const synthesisGestureUnsupportedHint = (device: DeviceInfo): string | undefined => {
  if (device.platform === 'macos')
    return 'macOS automation has no multi-touch input — this gesture is supported on Android and the iOS simulator only.';
  if (device.platform === 'ios' && device.target === 'tv')
    return 'tvOS has no touch input — this gesture is supported on Android and the iOS simulator only.';
  if (device.platform === 'ios' && device.kind === 'device')
    return 'Two-finger gesture synthesis is iOS-simulator only — not available on physical iOS devices.';
  return undefined;
};

// Which commands carry which supports()/unsupportedHint() closure today. The
// end-to-end assertions cross-check this map against production: a command that
// gains/loses a closure (or whose closure body changes) breaks parity.
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
    device.platform === 'macos' ||
    device.kind === 'simulator',
  keyboard: supportsAndroidOrIosNonTv,
  rotate: supportsAndroidOrIosNonTv,
  alert: (device) => device.platform === 'android' || isMacOsOrAppleSimulator(device),
  settings: (device) =>
    device.platform === 'android' || device.platform === 'macos' || device.kind === 'simulator',
  pinch: supportsSynthesisGesture,
  'rotate-gesture': supportsSynthesisGesture,
  'transform-gesture': supportsSynthesisGesture,
};
const HINT_REF: Record<string, (device: DeviceInfo) => string | undefined> = {
  pinch: synthesisGestureUnsupportedHint,
  'rotate-gesture': synthesisGestureUnsupportedHint,
  'transform-gesture': synthesisGestureUnsupportedHint,
};

// Independent reference for `isCommandSupportedOnDevice` over NON-WEB platforms,
// reproducing the BEFORE pipeline exactly: descriptor-fold bucket selection (b.1
// oracle) + the verbatim supports closure (b.2 oracle) + the kind check. For a
// non-web platform the augmented matrix equals BASE (the web augmentation only adds
// a `web` key), so BASE is the faithful capability source here.
function isSupportedReference(command: string, device: DeviceInfo): boolean {
  const capability: CommandCapability | undefined = BASE_COMMAND_CAPABILITY_MATRIX[command];
  if (!capability) return true;
  const byPlatform = deriveCapabilityForPlatform(platformDescriptors, capability, device.platform);
  if (!byPlatform) return false;
  const supports = SUPPORTS_REF[command];
  if (supports && !supports(device)) return false;
  const kind = (device.kind ?? 'unknown') as keyof NonNullable<CommandCapability['apple']>;
  return byPlatform[kind] === true;
}

test('(b.1) plugin-bucket selection is byte-identical to the platformDescriptors fold', () => {
  // Object identities per bucket so a wrong-bucket selection fails ===, plus a
  // web-bearing shape (BASE never carries a `web` key) so the `web` bucket route is
  // exercised with a defined value, and a sparse shape for undefined propagation.
  const shapes: CommandCapability[] = [
    ...Object.values(BASE_COMMAND_CAPABILITY_MATRIX),
    {
      apple: { simulator: true, device: true },
      android: { emulator: true, device: true, unknown: true },
      linux: { device: true },
      web: { device: true },
    },
    { apple: { simulator: true } },
  ];
  for (const capability of shapes) {
    for (const platform of PLATFORMS) {
      assert.deepEqual(
        capability[getPlugin(platform).capability.bucket],
        deriveCapabilityForPlatform(platformDescriptors, capability, platform),
        `bucket selection for ${platform}`,
      );
    }
  }
});

test('(b.1) isCommandSupportedOnDevice is unchanged across the command x device matrix', () => {
  const commands = listCapabilityCommands();
  for (const command of commands) {
    for (const device of SAMPLE_DEVICES) {
      // BASE lacks the `web` augmentation, so the descriptor-fold reference is only
      // faithful off the web platform; the web bucket route is pinned separately by
      // the (b.1) bucket-selection test above and the web column of capabilities.test.ts.
      if (device.platform === 'web') continue;
      assert.equal(
        isCommandSupportedOnDevice(command, device),
        isSupportedReference(command, device),
        `${command} on ${device.id}`,
      );
    }
  }
});

test('(b.2) unsupportedHint closures are verbatim across the full device matrix', () => {
  const commands = listCapabilityCommands();
  for (const command of commands) {
    const reference = HINT_REF[command];
    for (const device of SAMPLE_DEVICES) {
      assert.equal(
        unsupportedHintForDevice(command, device),
        reference ? reference(device) : undefined,
        `${command} hint on ${device.id}`,
      );
    }
  }
});

test('(b.2) every command carrying a supports closure is covered by the reference map', () => {
  // Guards the SUPPORTS_REF/HINT_REF oracle against silently missing a closure: a
  // command whose admission depends on a supports gate must appear in SUPPORTS_REF,
  // and every hint-bearing command must appear in HINT_REF.
  for (const command of listCapabilityCommands()) {
    const capability = BASE_COMMAND_CAPABILITY_MATRIX[command];
    if (capability?.supports) {
      assert.ok(SUPPORTS_REF[command], `${command} supports closure present in reference map`);
    }
    if (capability?.unsupportedHint) {
      assert.ok(HINT_REF[command], `${command} unsupportedHint closure present in reference map`);
    }
  }
});
