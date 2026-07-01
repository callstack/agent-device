import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  ANDROID_EMULATOR,
  IOS_SIMULATOR,
  WEB_DESKTOP_DEVICE,
  makeAndroidSession,
  makeIosSession,
  makeSession,
} from '../../__tests__/test-utils/index.ts';
import { withTargetDeviceResolutionScope } from '../../core/dispatch-resolve.ts';
import {
  createLocalAppleToolProvider,
  runXcrun,
} from '../../platforms/apple/core/tool-provider.ts';
import { resolveWebProvider, type WebProvider } from '../../platforms/web/provider.ts';
import type { DeviceInfo } from '../../kernel/device.ts';
import { withRequestPlatformProviderScope } from '../request-platform-providers.ts';
import type { DaemonRequest } from '../types.ts';

const OTHER_IOS_SIMULATOR: DeviceInfo = {
  platform: 'apple',
  id: 'sim-2',
  name: 'iPhone 17',
  kind: 'simulator',
  booted: true,
};

test('request platform provider scope applies Apple tool provider only for Apple sessions', async () => {
  const calls: string[][] = [];

  const result = await withRequestPlatformProviderScope(
    {
      req: request('open'),
      existingSession: makeIosSession('default'),
      providers: {
        appleToolProvider: ({ device }) => {
          assert.equal(device.id, IOS_SIMULATOR.id);
          return createLocalAppleToolProvider({
            runCommand: async (cmd, args) => {
              throw new Error(`unexpected generic command: ${cmd} ${args.join(' ')}`);
            },
            simctl: {
              run: async (args) => {
                calls.push(args);
                return { exitCode: 0, stdout: 'simctl-ok', stderr: '' };
              },
            },
          });
        },
        linuxToolProvider: () => {
          throw new Error('Linux provider should not apply to an iOS session');
        },
      },
    },
    async () => await runXcrun(['simctl', 'list', 'devices', '-j']),
  );

  assert.equal(result.stdout, 'simctl-ok');
  assert.deepEqual(calls, [['list', 'devices', '-j']]);
});

test('request platform provider scope follows explicit apps selector for existing sessions', async () => {
  const seenDevices: string[] = [];

  const result = await withTargetDeviceResolutionScope(
    async () => [OTHER_IOS_SIMULATOR],
    async () =>
      await withRequestPlatformProviderScope(
        {
          req: {
            ...request('apps'),
            flags: {
              platform: 'ios',
              device: 'iPhone 17',
            },
          },
          existingSession: makeIosSession('default'),
          providers: {
            appleToolProvider: ({ device, session }) => {
              seenDevices.push(`${session?.name}:${device.id}`);
              return createLocalAppleToolProvider({
                runCommand: async (cmd, args) => {
                  throw new Error(`unexpected generic command: ${cmd} ${args.join(' ')}`);
                },
                simctl: {
                  run: async () => ({ exitCode: 0, stdout: 'apps-ok', stderr: '' }),
                },
              });
            },
          },
        },
        async () => await runXcrun(['simctl', 'listapps', OTHER_IOS_SIMULATOR.id]),
      ),
  );

  assert.equal(result.stdout, 'apps-ok');
  assert.deepEqual(seenDevices, [`default:${OTHER_IOS_SIMULATOR.id}`]);
});

test('request platform provider scope skips sharded test orchestration requests', async () => {
  let providerCalls = 0;

  const result = await withTargetDeviceResolutionScope(
    async () => {
      throw new Error('Sharded test orchestration should not resolve a provider device');
    },
    async () =>
      await withRequestPlatformProviderScope(
        {
          req: {
            ...request('test'),
            flags: {
              platform: 'ios',
              shardAll: 2,
            },
          },
          existingSession: undefined,
          providers: {
            appleToolProvider: () => {
              providerCalls += 1;
              return createLocalAppleToolProvider();
            },
          },
        },
        async () => 'unscoped',
      ),
  );

  assert.equal(result, 'unscoped');
  assert.equal(providerCalls, 0);
});

test('request platform provider scopes stay isolated across concurrent requests', async () => {
  const androidCalls: string[] = [];
  const appleCalls: string[] = [];
  let androidEntered!: () => void;
  let appleEntered!: () => void;
  const androidInProvider = new Promise<void>((resolve) => {
    androidEntered = resolve;
  });
  const appleInProvider = new Promise<void>((resolve) => {
    appleEntered = resolve;
  });
  const bothProvidersEntered = Promise.all([androidInProvider, appleInProvider]);

  const androidTask = withRequestPlatformProviderScope(
    {
      req: { ...request('snapshot'), meta: { requestId: 'req-android' } },
      existingSession: makeAndroidSession('android-session'),
      providers: {
        androidAdbProvider: ({ device, session }) => ({
          exec: async (args) => {
            androidCalls.push(`${session?.name}:${device.id}:${args.join(' ')}`);
            androidEntered();
            await bothProvidersEntered;
            return { exitCode: 0, stdout: 'android-ok', stderr: '' };
          },
        }),
        appleToolProvider: () => {
          throw new Error('Apple provider should not apply to an Android request');
        },
      },
    },
    async (scope) => {
      assert.ok(scope.androidAdbExecutor);
      return (await scope.androidAdbExecutor(['shell', 'echo', 'android'])).stdout;
    },
  );

  const appleTask = withRequestPlatformProviderScope(
    {
      req: { ...request('snapshot'), meta: { requestId: 'req-apple' } },
      existingSession: makeIosSession('ios-session'),
      providers: {
        androidAdbProvider: () => {
          throw new Error('Android provider should not apply to an Apple request');
        },
        appleToolProvider: ({ device, session }) =>
          createLocalAppleToolProvider({
            runCommand: async (cmd, args) => {
              throw new Error(`unexpected generic command: ${cmd} ${args.join(' ')}`);
            },
            simctl: {
              run: async (args) => {
                appleCalls.push(`${session?.name}:${device.id}:${args.join(' ')}`);
                appleEntered();
                await bothProvidersEntered;
                return { exitCode: 0, stdout: 'apple-ok', stderr: '' };
              },
            },
          }),
      },
    },
    async () => (await runXcrun(['simctl', 'list', 'devices', '-j'])).stdout,
  );

  assert.deepEqual(await Promise.all([androidTask, appleTask]), ['android-ok', 'apple-ok']);
  assert.deepEqual(androidCalls, [`android-session:${ANDROID_EMULATOR.id}:shell echo android`]);
  assert.deepEqual(appleCalls, [`ios-session:${IOS_SIMULATOR.id}:list devices -j`]);
});

test('request platform provider scope applies web provider only for web sessions', async () => {
  const calls: string[] = [];
  const webProvider = makeWebProvider({
    async open(target) {
      calls.push(`open:${target}`);
    },
  });

  await withRequestPlatformProviderScope(
    {
      req: request('open'),
      existingSession: makeSession('web-session', { device: WEB_DESKTOP_DEVICE }),
      providers: {
        webProvider: ({ device, session }) => {
          calls.push(`${session?.name}:${device.id}`);
          return webProvider;
        },
        linuxToolProvider: () => {
          throw new Error('Linux provider should not apply to a web session');
        },
      },
    },
    async () => await resolveWebProvider().open('https://example.test'),
  );

  assert.deepEqual(calls, ['web-session:agent-browser-chrome', 'open:https://example.test']);
});

test('request platform provider scope follows explicit web selector', async () => {
  const seenDevices: string[] = [];

  await withTargetDeviceResolutionScope(
    async () => [WEB_DESKTOP_DEVICE],
    async () =>
      await withRequestPlatformProviderScope(
        {
          req: {
            ...request('snapshot'),
            flags: {
              platform: 'web',
            },
          },
          existingSession: undefined,
          providers: {
            webProvider: ({ device, session }) => {
              seenDevices.push(`${session?.name ?? 'none'}:${device.id}`);
              return makeWebProvider();
            },
            appleToolProvider: () => {
              throw new Error('Apple provider should not apply to a web request');
            },
          },
        },
        async () => await resolveWebProvider().snapshot(),
      ),
  );

  assert.deepEqual(seenDevices, ['none:agent-browser-chrome']);
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

function makeWebProvider(overrides: Partial<WebProvider> = {}): WebProvider {
  return {
    open: async () => {},
    close: async () => {},
    snapshot: async () => ({ nodes: [] }),
    screenshot: async () => {},
    setViewport: async () => {},
    click: async () => {},
    fill: async () => {},
    typeText: async () => {},
    scroll: async () => {},
    ...overrides,
  };
}
