import { REQUIRED_PLATFORMS } from '@agent-device/contracts/platform-module';
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
import { builtinPlatformPlugins } from './interactors/builtin-platform-plugin-set.ts';
import { linuxSelectionFixture } from '../platform-runtime-linux-provider.fixtures.ts';
import { vegaSelectionFixture } from '../platform-runtime-vega-provider.fixtures.ts';
import { webSelectionFixture } from '../platform-runtime-web-provider.fixtures.ts';
import {
  createRequestPlatformProviders,
  type PlatformProviderResolvers,
} from '../platform-runtime.ts';

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

function gatedResolversByHand(
  device: DeviceInfo,
  served: Partial<Record<'linux' | 'vega' | 'web', boolean>> = {},
): Set<PlatformGatedProviderResolverKey> {
  const applies = new Set<PlatformGatedProviderResolverKey>();
  if (device.platform === 'android') applies.add('androidAdbProvider');
  if (isApplePlatform(device.platform)) {
    applies.add('appleRunnerProvider');
    applies.add('appleToolProvider');
  }
  // An optional family this process does not serve is never asked for a provider: its selection is
  // absent, so there is no scope to enter and a resolver may otherwise open a session nothing closes.
  if (device.platform === 'vega' && served.vega === true) applies.add('vegaToolProvider');
  if (device.platform === 'linux' && served.linux === true) applies.add('linuxToolProvider');
  // Web is the exception: its resolver has no session or process to open, so it runs for a web device
  // either way, and only the scope entry needs the selection.
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

const PLUGIN_OWNED_KEYS: PlatformGatedProviderResolverKey[] = [
  'linuxToolProvider',
  'vegaToolProvider',
  'webProvider',
];
const BUILT_IN_KEYS = GATED_KEYS.filter((key) => !PLUGIN_OWNED_KEYS.includes(key));

test('built-in provider facets retain the former routing', () => {
  // The plugin-owned families carry their own request scope, so the builtin facets declare only
  // the resolvers the packed core still owns.
  for (const device of SAMPLE_DEVICES) {
    const facet = builtinPlatformPlugins.tryGet(device.platform)?.plugin.providers;
    const expected = gatedResolversByHand(device);
    for (const key of BUILT_IN_KEYS) {
      const applies = facet?.platformGatedResolvers.includes(key) ?? false;
      assert.equal(applies, expected.has(key), `gate for ${key} on ${device.id}`);
    }
    for (const key of PLUGIN_OWNED_KEYS) {
      assert.equal(
        facet?.platformGatedResolvers.includes(key) ?? false,
        false,
        `${key} belongs to a platform plugin, not to a builtin facet`,
      );
    }
  }
});

test('the built-in families carry only the resolvers they own', () => {
  assert.deepEqual(
    [...builtinPlatformPlugins.get('apple').plugin.providers!.platformGatedResolvers].sort(),
    ['appleRunnerProvider', 'appleToolProvider'],
  );
  assert.deepEqual(
    [...builtinPlatformPlugins.get('android').plugin.providers!.platformGatedResolvers],
    ['androidAdbProvider'],
  );
  // The managed families answer for themselves: their selections are what gate their resolvers, so
  // no builtin facet may claim one.
  assert.equal(builtinPlatformPlugins.tryGet('linux'), undefined);
});

test('root provider composition asks an optional family only when the process serves it', async () => {
  // Served families are supplied here; a family the process does not serve is the same run with its
  // selection left out, and then its resolver must not run at all.
  const served = {
    linux: linuxSelectionFixture(),
    vega: vegaSelectionFixture(),
    web: webSelectionFixture(),
  };
  for (const serves of [true, false] as const) {
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
      await createRequestPlatformProviders({
        providers,
        ...(serves ? { linux: served.linux, vega: served.vega, web: served.web } : {}),
      }).run(context, async () => {});

      const gatedInvoked = new Set(GATED_KEYS.filter((key) => invoked.has(key)));
      assert.deepEqual(
        [...gatedInvoked].sort(),
        [
          ...gatedResolversByHand(device, serves ? { linux: true, vega: true, web: true } : {}),
        ].sort(),
        `gated resolvers invoked for ${device.id}`,
      );
      for (const key of UNGATED_KEYS) {
        assert.ok(invoked.has(key), `ungated resolver ${key} must run for ${device.id}`);
      }
    }
  }
});

test('every required family is registered at the provider gate; optional families may be absent', () => {
  // Completeness is enforced for the required families (ADR 0034): each resolves to a builtin
  // plugin that owns it. The optional families stay registered today as well, so this run
  // exercises the full gate; their absence path is covered by
  // platform-plugin-registry-optional-family.test.ts.
  for (const family of REQUIRED_PLATFORMS) {
    const plugin = builtinPlatformPlugins.get(family).plugin;
    assert.ok(plugin.platforms.includes(family), `${family} plugin owns ${family}`);
    assert.equal(builtinPlatformPlugins.tryGet(family) !== undefined, true);
  }
});
