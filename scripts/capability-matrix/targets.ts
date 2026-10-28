// The device shapes the capability matrix reports on. Each entry is one column
// on the page, and each one is a device record the owning runtime accepts, so
// `inspectFacts` answers for a real target rather than a hand-written summary.
//
// A cloud column answers for a session the provider owns: the runtime allocates
// its lease first and reads facts from the device its own inventory returns.

import type { DeviceInfo } from '@agent-device/kernel/device';

export type TargetGroup = 'local-mobile' | 'local-tv' | 'local-desktop-web' | 'provider';

export type LocalTarget = Readonly<{
  kind: 'local';
  id: string;
  label: string;
  group: TargetGroup;
  device: DeviceInfo;
}>;

export type CloudWebDriverTarget = Readonly<{
  kind: 'cloud-webdriver';
  id: string;
  label: string;
  group: TargetGroup;
  provider: string;
  platform: 'android' | 'ios';
  /** Shorter name used when this column merges with the provider's other platform. */
  mergeLabel: string;
  /** Provider plugin to load: bundled registration, or the plugin package's `setup()`. */
  plugin: 'browserstack' | 'aws-device-farm' | 'testmu';
  flags: Readonly<Record<string, unknown>>;
}>;

export type LimrunTarget = Readonly<{
  kind: 'limrun';
  id: string;
  label: string;
  group: TargetGroup;
  backend: 'ios-instance' | 'android-instance';
  platform: 'ios' | 'android';
  device: DeviceInfo;
}>;

export type Target = LocalTarget | CloudWebDriverTarget | LimrunTarget;

const booted = { booted: true } as const;

export const TARGETS: readonly Target[] = [
  {
    kind: 'local',
    id: 'ios-sim',
    label: 'iOS Simulator',
    group: 'local-mobile',
    device: {
      platform: 'apple',
      appleOs: 'ios',
      id: 'sim-1',
      name: 'iPhone 17 Pro',
      kind: 'simulator',
      target: 'mobile',
      ...booted,
    },
  },
  {
    // The CoreDevice-backed fixture. XCTest-backed physical devices answer as a
    // narrower column and are described by a header sentence on the page.
    kind: 'local',
    id: 'ios-device',
    label: 'iOS device (CoreDevice)',
    group: 'local-mobile',
    device: {
      platform: 'apple',
      appleOs: 'ios',
      id: 'device-1',
      name: 'iPhone 16',
      kind: 'device',
      target: 'mobile',
      iosPhysicalDeviceBackend: 'coredevice',
      ...booted,
    },
  },
  {
    kind: 'local',
    id: 'android-emulator',
    label: 'Android emulator',
    group: 'local-mobile',
    device: {
      platform: 'android',
      id: 'emulator-5554',
      name: 'Pixel_9_Pro',
      kind: 'emulator',
      target: 'mobile',
      ...booted,
    },
  },
  {
    kind: 'local',
    id: 'android-device',
    label: 'Android device',
    group: 'local-mobile',
    device: {
      platform: 'android',
      id: 'R5CT10FGNKE',
      name: 'Pixel 8',
      kind: 'device',
      target: 'mobile',
      ...booted,
    },
  },
  {
    kind: 'local',
    id: 'android-tv-emulator',
    label: 'Android TV emulator',
    group: 'local-tv',
    device: {
      platform: 'android',
      id: 'emulator-5556',
      name: 'android_tv_13',
      kind: 'emulator',
      target: 'tv',
      ...booted,
    },
  },
  {
    kind: 'local',
    id: 'android-tv-device',
    label: 'Android TV / Fire OS device',
    group: 'local-tv',
    device: {
      platform: 'android',
      id: '192.168.1.42:5555',
      name: 'AFT-S9A',
      kind: 'device',
      target: 'tv',
      ...booted,
    },
  },
  {
    kind: 'local',
    id: 'tvos-sim',
    label: 'tvOS Simulator',
    group: 'local-tv',
    device: {
      platform: 'apple',
      appleOs: 'tvos',
      id: 'tv-sim-1',
      name: 'Apple TV 4K (3rd generation)',
      kind: 'simulator',
      target: 'tv',
      ...booted,
    },
  },
  {
    kind: 'local',
    id: 'tvos-device',
    label: 'tvOS device',
    group: 'local-tv',
    device: {
      platform: 'apple',
      appleOs: 'tvos',
      id: 'tv-device-1',
      name: 'Apple TV 4K',
      kind: 'device',
      target: 'tv',
      iosPhysicalDeviceBackend: 'coredevice',
      ...booted,
    },
  },
  {
    kind: 'local',
    id: 'macos-desktop',
    label: 'macOS desktop',
    group: 'local-desktop-web',
    device: {
      platform: 'apple',
      appleOs: 'macos',
      id: 'mac-1',
      name: 'MacBook Pro',
      kind: 'device',
      target: 'desktop',
      ...booted,
    },
  },
  {
    kind: 'local',
    id: 'macos-app',
    label: 'macOS app',
    group: 'local-desktop-web',
    device: {
      platform: 'apple',
      appleOs: 'macos',
      id: 'mac-1:app:com.example.editor',
      name: 'MacBook Pro',
      kind: 'device',
      target: 'desktop',
      hostApp: { hostDeviceId: 'mac-1', bundleId: 'com.example.editor' },
      ...booted,
    },
  },
  {
    kind: 'local',
    id: 'linux-desktop',
    label: 'Linux desktop',
    group: 'local-desktop-web',
    device: {
      platform: 'linux',
      id: 'linux-1',
      name: 'GNOME desktop',
      kind: 'device',
      target: 'desktop',
      ...booted,
    },
  },
  {
    kind: 'local',
    id: 'web-browser',
    label: 'Web browser',
    group: 'local-desktop-web',
    device: {
      platform: 'web',
      id: 'web-1',
      name: 'Chrome',
      kind: 'device',
      ...booted,
    },
  },
  {
    kind: 'local',
    id: 'vega-vvd',
    label: 'Vega OS (VVD)',
    group: 'local-tv',
    device: {
      platform: 'vega',
      id: 'vega-1',
      name: 'Vega Virtual Device',
      kind: 'emulator',
      target: 'tv',
      ...booted,
    },
  },
  {
    kind: 'local',
    id: 'harmonyos-emulator',
    label: 'HarmonyOS emulator',
    group: 'local-mobile',
    device: {
      platform: 'harmonyos',
      id: 'harmony-emulator-1',
      name: 'Mate 60 Pro',
      kind: 'emulator',
      target: 'mobile',
      ...booted,
    },
  },
  {
    kind: 'local',
    id: 'harmonyos-device',
    label: 'HarmonyOS device',
    group: 'local-mobile',
    device: {
      platform: 'harmonyos',
      id: 'harmony-device-1',
      name: 'Mate 60 Pro',
      kind: 'device',
      target: 'mobile',
      ...booted,
    },
  },
  {
    kind: 'cloud-webdriver',
    id: 'browserstack-android',
    label: 'BrowserStack Android',
    group: 'provider',
    provider: 'browserstack',
    platform: 'android',
    mergeLabel: 'BrowserStack',
    plugin: 'browserstack',
    flags: {
      platform: 'android',
      device: 'Pixel 8',
      providerOsVersion: '14.0',
      providerApp: 'bs://pre-uploaded',
    },
  },
  {
    kind: 'cloud-webdriver',
    id: 'browserstack-ios',
    label: 'BrowserStack iOS',
    group: 'provider',
    provider: 'browserstack',
    platform: 'ios',
    mergeLabel: 'BrowserStack',
    plugin: 'browserstack',
    flags: {
      platform: 'ios',
      device: 'iPhone 15',
      providerOsVersion: '17.0',
      providerApp: 'bs://pre-uploaded',
    },
  },
  {
    kind: 'cloud-webdriver',
    id: 'testmu-android',
    label: 'TestMu AI Android',
    group: 'provider',
    provider: 'testmu',
    platform: 'android',
    mergeLabel: 'TestMu AI',
    plugin: 'testmu',
    flags: {
      platform: 'android',
      device: 'Pixel 8',
      providerOsVersion: '14.0',
      providerApp: 'lt://pre-uploaded',
    },
  },
  {
    kind: 'cloud-webdriver',
    id: 'testmu-ios',
    label: 'TestMu AI iOS',
    group: 'provider',
    provider: 'testmu',
    platform: 'ios',
    mergeLabel: 'TestMu AI',
    plugin: 'testmu',
    flags: {
      platform: 'ios',
      device: 'iPhone 15',
      providerOsVersion: '17.0',
      providerApp: 'lt://pre-uploaded',
    },
  },
  {
    kind: 'cloud-webdriver',
    id: 'aws-device-farm-android',
    label: 'AWS Device Farm Android',
    group: 'provider',
    provider: 'aws-device-farm',
    platform: 'android',
    mergeLabel: 'AWS Device Farm',
    plugin: 'aws-device-farm',
    flags: {
      platform: 'android',
      device: 'Pixel 8',
      awsProjectArn: 'arn:aws:devicefarm:us-west-2:123456789012:project/example-project',
      awsDeviceArn: 'arn:aws:devicefarm:us-west-2::device/example-device',
    },
  },
  {
    kind: 'cloud-webdriver',
    id: 'aws-device-farm-ios',
    label: 'AWS Device Farm iOS',
    group: 'provider',
    provider: 'aws-device-farm',
    platform: 'ios',
    mergeLabel: 'AWS Device Farm',
    plugin: 'aws-device-farm',
    flags: {
      platform: 'ios',
      device: 'iPhone 15',
      awsProjectArn: 'arn:aws:devicefarm:us-west-2:123456789012:project/example-project',
      awsDeviceArn: 'arn:aws:devicefarm:us-west-2::device/example-device',
    },
  },
  {
    kind: 'limrun',
    id: 'limrun-ios',
    label: 'Limrun iOS',
    group: 'provider',
    backend: 'ios-instance',
    platform: 'ios',
    device: {
      platform: 'apple',
      appleOs: 'ios',
      id: 'limrun:ios:lease-ios',
      name: 'Limrun iOS instance',
      kind: 'simulator',
      target: 'mobile',
      ...booted,
    },
  },
  {
    kind: 'limrun',
    id: 'limrun-android',
    label: 'Limrun Android',
    group: 'provider',
    backend: 'android-instance',
    platform: 'android',
    device: {
      platform: 'android',
      id: 'limrun:android:lease-android',
      name: 'Limrun Android instance',
      kind: 'emulator',
      target: 'mobile',
      ...booted,
    },
  },
];

export const TARGET_IDS: readonly string[] = TARGETS.map((target) => target.id);

/**
 * Columns that report the same available-operation set print as one column.
 * The signature reads operations, not commands: two targets can share every
 * command answer while differing on one operation, and merging them would hide
 * that from the per-operation cells.
 */
export function groupIdenticalColumns(
  ids: readonly string[],
  availability: ReadonlyMap<string, ReadonlySet<string>>,
): Array<{ readonly ids: readonly string[]; readonly id: string }> {
  const operations = [
    ...new Set([...ids].flatMap((id) => [...(availability.get(id) ?? [])])),
  ].sort();
  const bySignature = new Map<string, string[]>();
  for (const id of ids) {
    const supported = availability.get(id);
    if (!supported) throw new Error(`No capability facts were collected for target "${id}".`);
    const signature = operations
      .map((operation) => (supported.has(operation) ? '1' : '0'))
      .join('');
    const group = bySignature.get(signature);
    if (group) group.push(id);
    else bySignature.set(signature, [id]);
  }
  return [...bySignature.values()].map((group) => ({ id: group[0] as string, ids: group }));
}
