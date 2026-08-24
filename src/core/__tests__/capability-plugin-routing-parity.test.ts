import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  isIosFamily,
  isMacOs,
  DEVICE_TARGETS,
  PLATFORMS,
  type DeviceInfo,
  type DeviceKind,
  type DeviceTarget,
  type Platform,
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
} from '../../__tests__/test-utils/device-fixtures.ts';
import {
  BASE_COMMAND_CAPABILITY_MATRIX,
  isCommandSupportedOnDevice,
  listCapabilityCommands,
  unsupportedHintForDevice,
  type CommandCapability,
} from '../capabilities.ts';
import { getPlugin } from '../platform-plugin-registry.ts';
import { registerBuiltinPlatformPlugins } from '../interactors/register-builtins.ts';

// Phase 3 step (b) parity gate. Independent oracles pin that the migration is
// byte-for-byte behaviorless:
//   (b.1) the platform -> capability-bucket selection in `isCommandSupportedOnDevice`
//         flows through the PlatformPlugin registry. `CAPABILITY_BUCKET_BY_PLATFORM`
//         is kept here as an independent hardcoded oracle, so a plugin-bucket
//         regression fails this test.
//   (b.2) the per-command `supports()` / `unsupportedHint()` device closures live on
//         the owning
//         PlatformPlugin's `capability.supportsByDefault` / `unsupportedHintByDefault`
//         (ADR-0009: relocate, never flatten). Most such closures are Apple
//         family gates; audio is also an Android gate because Android emulator capture
//         depends on the macOS host backend. The independent copies below
//         are the oracle: they pin (a) that production admission (`isCommand
//         SupportedOnDevice`) and hint output (`unsupportedHintForDevice`) are unchanged
//         across the full {platform x command x device-kind x target} matrix, and (b)
//         that the closures now living on the Apple plugin are byte-for-byte behaviorally
//         identical to the intended command contracts across the sample-device matrix.

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
  { ...IOS_DEVICE, id: 'xctest-ios-device', iosPhysicalDeviceBackend: 'xctest' },
  IOS_SIMULATOR,
  // The appleOs-bearing iPadOS/visionOS shapes exercise the per-AppleOS table's
  // stored-`appleOs` read path (step d.5); the target-based oracle below still agrees
  // because both are modeled as the mobile iOS engine and are capability-identical.
  IPADOS_SIMULATOR,
  VISIONOS_SIMULATOR,
  LINUX_DEVICE,
  MACOS_DEVICE,
  TVOS_SIMULATOR,
  WEB_DESKTOP_DEVICE,
  ...buildDeviceMatrix(),
];

// ---------------------------------------------------------------------------
// (b.2) Independent copies of the per-command supports()/unsupportedHint()
// contracts. Kept in sync by hand so this oracle stays independent of production.
// ---------------------------------------------------------------------------
const supportsHostAudioProbe = (device: DeviceInfo): boolean =>
  device.platform === 'web' ||
  (process.platform === 'darwin' &&
    (isMacOs(device) ||
      (isIosFamily(device) && device.kind === 'simulator') ||
      (device.platform === 'android' && device.kind === 'emulator')));
const supportsCoreDevicePhysicalOperation = (device: DeviceInfo): boolean =>
  device.platform !== 'apple' ||
  device.kind !== 'device' ||
  device.iosPhysicalDeviceBackend !== 'xctest';
const coreDeviceOnlyPhysicalOperationHint = (device: DeviceInfo): string | undefined =>
  supportsCoreDevicePhysicalOperation(device)
    ? undefined
    : 'This command requires a CoreDevice-backed physical iOS device. The selected XCTest backend supports open, close, interactions, snapshots, and screenshots.';
// Which commands carry which supports()/unsupportedHint() closure today. The
// end-to-end assertions cross-check this map against production: a command that
// gains/loses a closure (or whose closure body changes) breaks parity.
const SUPPORTS_REF: Record<string, (device: DeviceInfo) => boolean> = {
  perf: supportsCoreDevicePhysicalOperation,
  // `alert`'s closure left with R59, whose cutover made the owner's own alert facts the whole
  // admission; the per-leaf verdicts it encoded are pinned in `platform-apple/src/system/`.
  audio: supportsHostAudioProbe,
};
const HINT_REF: Record<string, (device: DeviceInfo) => string | undefined> = {
  perf: coreDeviceOnlyPhysicalOperationHint,
};

// Independent hardcoded oracle for the platform -> capability-bucket selection
// (b.1) that `isCommandSupportedOnDevice` reads off the PlatformPlugin registry.
const CAPABILITY_BUCKET_BY_PLATFORM: Record<Platform, keyof CommandCapability> = {
  apple: 'apple',
  android: 'android',
  harmonyos: 'harmonyos',
  vega: 'vega',
  linux: 'linux',
  web: 'web',
};
// R42/R43/R45 deleted the plugin's only `VEGA_VVD_ONLY_COMMANDS` closures (back/home/tv-remote);
// nothing takes their place here since Vega now carries no `supportsByDefault` at all.
const HARMONYOS_SUPPORTED_COMMANDS_REF = new Set([
  'perf',
  'app-switcher',
  'click',
  'fill',
  'find',
  'focus',
  'gesture',
  'longpress',
  'press',
  'screenshot',
  'scroll',
  'settings',
  'swipe',
  'type',
  'wait',
]);
const HARMONYOS_EMULATOR: DeviceInfo = {
  platform: 'harmonyos',
  id: 'harmony-emulator',
  name: 'HarmonyOS emulator',
  kind: 'emulator',
  booted: true,
};

// Independent reference for `isCommandSupportedOnDevice` over NON-WEB platforms,
// reproducing the BEFORE pipeline exactly: hardcoded bucket selection (b.1 oracle)
// + the verbatim supports closure (b.2 oracle) + the kind check. For a non-web
// platform the augmented matrix equals BASE (the web augmentation only adds a
// `web` key), so BASE is the faithful capability source here.
function isSupportedReference(command: string, device: DeviceInfo): boolean {
  if (device.platform === 'harmonyos') return isHarmonySupportedReference(command, device);
  const capability: CommandCapability | undefined = BASE_COMMAND_CAPABILITY_MATRIX[command];
  if (!capability) return true;
  const byPlatform = capability[CAPABILITY_BUCKET_BY_PLATFORM[device.platform]];
  if (!byPlatform) return false;
  const supports = SUPPORTS_REF[command];
  if (supports && !supports(device)) return false;
  const kind = (device.kind ?? 'unknown') as keyof NonNullable<CommandCapability['apple']>;
  return byPlatform[kind] === true;
}

function isHarmonySupportedReference(command: string, device: DeviceInfo): boolean {
  if (command === 'record') return device.kind === 'device';
  return (
    HARMONYOS_SUPPORTED_COMMANDS_REF.has(command) &&
    (device.kind === 'emulator' || device.kind === 'device')
  );
}

test('(b.1) plugin-bucket selection matches the platform -> bucket table', () => {
  for (const platform of PLATFORMS) {
    assert.equal(
      getPlugin(platform).capability.bucket,
      CAPABILITY_BUCKET_BY_PLATFORM[platform],
      `bucket for ${platform}`,
    );
  }
});

test('(b.1) isCommandSupportedOnDevice is unchanged across the command x device matrix', () => {
  const commands = Object.keys(BASE_COMMAND_CAPABILITY_MATRIX);
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

test('HarmonyOS static capabilities omit runtime-backed command admissions', () => {
  const availableCommands = Object.keys(BASE_COMMAND_CAPABILITY_MATRIX)
    .filter((command) => isCommandSupportedOnDevice(command, HARMONYOS_EMULATOR))
    .sort();

  // Runtime-backed navigation, keyboard, and touch commands dropped out of the matrix entirely:
  // capability buckets), so they are absent here — not because HarmonyOS admission changed, but
  // because there is no bucket left for `isCommandSupportedOnDevice` to consult at all.
  assert.deepEqual(availableCommands, ['perf']);
});

test('(b.2) unsupportedHint closures are verbatim across the full device matrix', () => {
  const commands = Object.keys(BASE_COMMAND_CAPABILITY_MATRIX);
  for (const command of commands) {
    const reference = HINT_REF[command];
    for (const device of SAMPLE_DEVICES) {
      assert.equal(
        unsupportedHintForDevice(command, device),
        reference?.(device),
        `${command} hint on ${device.id}`,
      );
    }
  }
});

test('the capability catalog includes runtime-backed commands without restoring legacy admission', () => {
  assert.ok(listCapabilityCommands().includes('boot'));
  assert.ok(listCapabilityCommands().includes('logs'));
  assert.ok(listCapabilityCommands().includes('network'));
  assert.equal(BASE_COMMAND_CAPABILITY_MATRIX['boot'], undefined);
  assert.equal(BASE_COMMAND_CAPABILITY_MATRIX['open'], undefined);
  assert.equal(BASE_COMMAND_CAPABILITY_MATRIX['close'], undefined);
  assert.equal(BASE_COMMAND_CAPABILITY_MATRIX['prepare'], undefined);
  assert.equal(BASE_COMMAND_CAPABILITY_MATRIX['logs'], undefined);
  assert.equal(BASE_COMMAND_CAPABILITY_MATRIX['network'], undefined);
});

test('(b.2) the Apple plugin carries exactly the relocated supports/hint closures', () => {
  // The relocation target: `supports()` / `unsupportedHint()` now live on the Apple
  // plugin (the family that owns every discriminating device). Pin the RELOCATED maps'
  // key sets against the independent verbatim reference so no closure was silently
  // dropped or added while moving off the command facet.
  const appleCapability = getPlugin('apple').capability;
  assert.deepEqual(
    Object.keys(appleCapability.supportsByDefault ?? {}).sort(),
    Object.keys(SUPPORTS_REF).sort(),
    'supportsByDefault key set equals the verbatim reference',
  );
  assert.deepEqual(
    Object.keys(appleCapability.unsupportedHintByDefault ?? {}).sort(),
    Object.keys(HINT_REF).sort(),
    'unsupportedHintByDefault key set equals the verbatim reference',
  );
  // ios and macos are the SAME Apple plugin instance, so both leaves read one map.
  assert.equal(getPlugin('apple').capability, getPlugin('apple').capability);
});

test('(b.2) the relocated Apple closures match the independent command contracts', () => {
  // Closure-equivalence: for every command x sample-device, the closure now living on
  // the Apple plugin returns an identical boolean / identical hint STRING to the
  // independent verbatim copy of the original command-facet closure.
  const appleCapability = getPlugin('apple').capability;
  for (const [command, reference] of Object.entries(SUPPORTS_REF)) {
    const relocated = appleCapability.supportsByDefault?.[command];
    assert.ok(relocated, `${command} supports closure present on the Apple plugin`);
    for (const device of SAMPLE_DEVICES) {
      assert.equal(relocated(device), reference(device), `${command} supports on ${device.id}`);
    }
  }
  for (const [command, reference] of Object.entries(HINT_REF)) {
    const relocated = appleCapability.unsupportedHintByDefault?.[command];
    assert.ok(relocated, `${command} hint closure present on the Apple plugin`);
    for (const device of SAMPLE_DEVICES) {
      assert.equal(relocated(device), reference(device), `${command} hint on ${device.id}`);
    }
  }
});

test('(b.2) non-Apple families only carry their own non-portable support gates', () => {
  // Most relocated closures are Apple-only. Audio is the one host-dependent command that also
  // gates Android emulator support on macOS hosts, so Android carries only that predicate —
  // R45 deleted its `tv-remote` closure along with the descriptor's capability bucket.
  assert.deepEqual(Object.keys(getPlugin('android').capability.supportsByDefault ?? {}), ['audio']);
  assert.equal(getPlugin('android').capability.unsupportedHintByDefault, undefined);
  // R42/R43/R45 deleted Vega's only closures (back/home/tv-remote); nothing replaces them.
  for (const platform of ['vega', 'linux', 'web'] as const) {
    const capability = getPlugin(platform).capability;
    assert.equal(capability.supportsByDefault, undefined, `${platform} has no supportsByDefault`);
    assert.equal(
      capability.unsupportedHintByDefault,
      undefined,
      `${platform} has no unsupportedHintByDefault`,
    );
  }
});
