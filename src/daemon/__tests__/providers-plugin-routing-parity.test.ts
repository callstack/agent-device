import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  isApplePlatform,
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
  IPADOS_SIMULATOR,
  LINUX_DEVICE,
  MACOS_DEVICE,
  makeSession,
  TVOS_SIMULATOR,
  VISIONOS_SIMULATOR,
  WEB_DESKTOP_DEVICE,
} from '../../__tests__/test-utils/index.ts';
import { getPlugin, tryGetPlugin } from '../../core/platform-plugin/plugin.ts';
import { registerBuiltinPlatformPlugins } from '../../core/interactors/register-builtins.ts';
import {
  withRequestPlatformProviderScope,
  type PlatformGatedProviderResolverKey,
  type PlatformProviderResolvers,
} from '../request-platform-providers.ts';
import type { DaemonRequest } from '../types.ts';

// Phase 3 step b.3 (issue #974) parity gate for the daemon request-scope provider
// facet. The per-platform GATE that each descriptor in `request-platform-providers.ts`
// open-coded (`device.platform === 'android'`, `isApplePlatform(...)`, etc.) now flows
// through the PlatformPlugin `providers.platformGatedResolvers` facet. The daemon still
// OWNS the resolver invocation, wrapper composition, and concurrency isolation — only
// the gate moved to data. An INDEPENDENT verbatim copy of the former gates below is the
// BEFORE oracle, checked at the facet level AND end-to-end through
// `withRequestPlatformProviderScope`.

registerBuiltinPlatformPlugins();

// The platform-gated resolver keys, and the two ungated resolvers (no platform gate;
// they apply on every platform and are NOT part of the facet).
const GATED_KEYS: PlatformGatedProviderResolverKey[] = [
  'androidAdbProvider',
  'appleRunnerProvider',
  'appleToolProvider',
  'linuxToolProvider',
  'webProvider',
];
const UNGATED_KEYS = ['appLogProvider', 'recordingProvider'] as const;

// --- INDEPENDENT verbatim copy of the former per-descriptor platform gates ---
function gatedResolversByHand(device: DeviceInfo): Set<PlatformGatedProviderResolverKey> {
  const applies = new Set<PlatformGatedProviderResolverKey>();
  if (device.platform === 'android') applies.add('androidAdbProvider'); // was `!== 'android'`
  if (isApplePlatform(device.platform)) {
    applies.add('appleRunnerProvider'); // was `!isApplePlatform(...)`
    applies.add('appleToolProvider'); // was `!isApplePlatform(...)`
  }
  if (device.platform === 'linux') applies.add('linuxToolProvider'); // was `!== 'linux'`
  if (device.platform === 'web') applies.add('webProvider'); // was `!== 'web'`
  return applies;
}

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
  // Apple owns ios + macos (SAME plugin instance). Unlike appLog/perf, EVERY family
  // owns at least one platform-specific resolver, so all four carry the facet.
  assert.equal(getPlugin('apple'), getPlugin('apple'));
  assert.deepEqual([...getPlugin('apple').providers!.platformGatedResolvers].sort(), [
    'appleRunnerProvider',
    'appleToolProvider',
  ]);
  assert.deepEqual(
    [...getPlugin('android').providers!.platformGatedResolvers],
    ['androidAdbProvider'],
  );
  assert.deepEqual(
    [...getPlugin('linux').providers!.platformGatedResolvers],
    ['linuxToolProvider'],
  );
  assert.deepEqual([...getPlugin('web').providers!.platformGatedResolvers], ['webProvider']);
});

// End-to-end routing proof: drive the REAL `withRequestPlatformProviderScope` with a
// spy for every resolver and assert exactly the gated resolvers the former hand gate
// admitted are invoked (plus the two ungated resolvers, on every platform). Each spy
// returns `undefined`, so no wrapper is composed — but the resolver is still called iff
// its gate passed, which is precisely what the former `device.platform === …` branch
// decided. Breaking the facet flips which resolvers run and fails this test.
test('withRequestPlatformProviderScope invokes exactly the resolvers the former gate did', async () => {
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
      linuxToolProvider: spy('linuxToolProvider'),
      webProvider: spy('webProvider'),
      appLogProvider: spy('appLogProvider'),
      recordingProvider: spy('recordingProvider'),
    };

    await withRequestPlatformProviderScope(
      {
        req: request('snapshot'),
        existingSession: makeSession(`prov-${device.id}`, { device }),
        providers,
      },
      async () => {},
    );

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

function request(command: string): DaemonRequest {
  return {
    token: 'test-token',
    session: 'default',
    command,
    positionals: [],
    flags: {},
    meta: { requestId: `req-${command}` },
  };
}
