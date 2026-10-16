import type {
  PlatformGatedProviderResolverKey,
  PlatformProviderRequestContext,
} from '@agent-device/contracts/platform-providers';
import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  isApplePlatform,
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
} from '@agent-device/test-kit';
import { getPlugin, tryGetPlugin } from './platform-plugin-registry.ts';
import { registerBuiltinPlatformPlugins } from './interactors/register-builtins.ts';
import {
  createRequestPlatformProviders,
  type PlatformProviderResolvers,
} from '../platform-runtime.ts';

registerBuiltinPlatformPlugins();

const GATED_KEYS: PlatformGatedProviderResolverKey[] = [
  'androidAdbProvider',
  'appleRunnerProvider',
  'appleToolProvider',
  'vegaToolProvider',
  'linuxToolProvider',
  'webProvider',
];
const UNGATED_KEYS = [
  'appleRunnerScreenRecordingTransport',
  'appleSimulatorScreenRecordingTransport',
] as const;

function gatedResolversByHand(device: DeviceInfo): Set<PlatformGatedProviderResolverKey> {
  const applies = new Set<PlatformGatedProviderResolverKey>();
  if (device.platform === 'android') applies.add('androidAdbProvider');
  if (isApplePlatform(device.platform)) {
    applies.add('appleRunnerProvider');
    applies.add('appleToolProvider');
  }
  if (device.platform === 'vega') applies.add('vegaToolProvider');
  if (device.platform === 'linux') applies.add('linuxToolProvider');
  if (device.platform === 'web') applies.add('webProvider');
  return applies;
}

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

const SAMPLE_DEVICES: DeviceInfo[] = [
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
  ...buildDeviceMatrix(),
];

test('providers.platformGatedResolvers facet is byte-identical to the former hand gate', () => {
  for (const device of SAMPLE_DEVICES) {
    const facet = tryGetPlugin(device.platform)?.providers;
    const expected = gatedResolversByHand(device);
    for (const key of GATED_KEYS) {
      const applies = facet?.platformGatedResolvers.includes(key) ?? false;
      assert.equal(applies, expected.has(key), `gate for ${key} on ${device.id}`);
    }
  }
});

test('every family carries the providers facet with the resolvers it owns', () => {
  assert.deepEqual([...getPlugin('apple').providers!.platformGatedResolvers].sort(), [
    'appleRunnerProvider',
    'appleToolProvider',
  ]);
  assert.deepEqual(
    [...getPlugin('android').providers!.platformGatedResolvers],
    ['androidAdbProvider'],
  );
  assert.deepEqual([...getPlugin('vega').providers!.platformGatedResolvers], ['vegaToolProvider']);
  assert.deepEqual(
    [...getPlugin('linux').providers!.platformGatedResolvers],
    ['linuxToolProvider'],
  );
  assert.deepEqual([...getPlugin('web').providers!.platformGatedResolvers], ['webProvider']);
});

test('root provider composition invokes exactly the resolvers the former gate did', async () => {
  for (const device of SAMPLE_DEVICES) {
    const invoked = new Set<string>();
    const spy = (key: string) => (): undefined => {
      invoked.add(key);
      return undefined;
    };
    const providers: PlatformProviderResolvers = {
      androidAdbProvider: spy('androidAdbProvider'),
      appleRunnerProvider: spy('appleRunnerProvider'),
      appleToolProvider: spy('appleToolProvider'),
      vegaToolProvider: spy('vegaToolProvider'),
      linuxToolProvider: spy('linuxToolProvider'),
      webProvider: spy('webProvider'),
      appleRunnerScreenRecordingTransport: spy('appleRunnerScreenRecordingTransport'),
      appleSimulatorScreenRecordingTransport: spy('appleSimulatorScreenRecordingTransport'),
    };

    const name = `prov-${device.id}`;
    const context: PlatformProviderRequestContext = {
      device,
      session: { name, device },
      requestedSession: name,
      requestId: `req-${device.id}`,
    };
    await createRequestPlatformProviders({ providers }).run(context, async () => {});

    const gatedInvoked = new Set(GATED_KEYS.filter((key) => invoked.has(key)));
    assert.deepEqual(
      [...gatedInvoked].sort(),
      [...gatedResolversByHand(device)].sort(),
      `gated resolvers invoked for ${device.id}`,
    );
    for (const key of UNGATED_KEYS) {
      assert.ok(invoked.has(key), `ungated resolver ${key} must run for ${device.id}`);
    }
  }
});
