import assert from 'node:assert/strict';
import { test } from 'vitest';
import type {
  PlatformProviderRequestContext,
  RequestPlatformProviderScope,
} from '@agent-device/contracts/platform-providers';
import {
  ANDROID_EMULATOR,
  IOS_SIMULATOR,
  MACOS_DEVICE,
  WEB_DESKTOP_DEVICE,
} from '@agent-device/test-kit';
import { createLocalAppleToolProvider, runXcrun } from '@agent-device/platform-apple/tool-provider';
import { buildSimctlArgsForDevice } from '@agent-device/platform-apple/simctl';
import type { AndroidAdbExecutor } from '@agent-device/platform-android/mechanics';
import { resolveWebProvider, type WebProvider } from '@agent-device/platform-web';
import {
  resolveAppleRunnerScreenRecordingTransport,
  type AppleRunnerScreenRecordingTransport,
} from './platform-runtime-screen-recording-apple-runner-transport.ts';
import {
  createRequestPlatformProviders,
  type PlatformProviderResolvers,
} from './platform-runtime.ts';

const OTHER_IOS_SIMULATOR = {
  platform: 'apple',
  id: 'sim-2',
  name: 'iPhone 17',
  kind: 'simulator',
  booted: true,
} as const;

test('Apple provider scope uses the request device for Apple tool calls', async () => {
  const calls: string[][] = [];
  const result = await withRequestPlatformProviderScope(
    context(IOS_SIMULATOR),
    {
      appleToolProvider: ({ device }) => {
        assert.equal(device.id, IOS_SIMULATOR.id);
        return createLocalAppleToolProvider({
          runCommand: async (cmd, args) => {
            throw new Error(`unexpected generic command: ${cmd} ${args.join(' ')}`);
          },
          simctl: {
            run: async (args) => {
              calls.push([...args]);
              return { exitCode: 0, stdout: 'simctl-ok', stderr: '' };
            },
          },
        });
      },
      linuxToolProvider: () => {
        throw new Error('Linux provider should not apply to an iOS session');
      },
    },
    async () => await runXcrun(buildSimctlArgsForDevice(IOS_SIMULATOR, ['list', 'devices', '-j'])),
  );

  assert.equal(result.stdout, 'simctl-ok');
  assert.deepEqual(calls, [['list', 'devices', '-j']]);
});

test('Apple provider scope keeps the context device when it differs from the active session', async () => {
  const seenDevices: string[] = [];
  const result = await withRequestPlatformProviderScope(
    { ...context(IOS_SIMULATOR), device: OTHER_IOS_SIMULATOR },
    {
      appleToolProvider: ({ device, session }) => {
        seenDevices.push(`${session?.name}:${device.id}`);
        return createLocalAppleToolProvider({
          runCommand: async (cmd, args) => {
            throw new Error(`unexpected generic command: ${cmd} ${args.join(' ')}`);
          },
          simctl: { run: async () => ({ exitCode: 0, stdout: 'apps-ok', stderr: '' }) },
        });
      },
    },
    async () =>
      await runXcrun(
        buildSimctlArgsForDevice(OTHER_IOS_SIMULATOR, ['listapps', OTHER_IOS_SIMULATOR.id]),
      ),
  );

  assert.equal(result.stdout, 'apps-ok');
  assert.deepEqual(seenDevices, [`default:${OTHER_IOS_SIMULATOR.id}`]);
});

test('concurrent provider scopes stay isolated', async () => {
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
    context(ANDROID_EMULATOR, 'android-session', 'req-android'),
    {
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
    async (scope) => {
      const executor = scope.androidAdbExecutor as AndroidAdbExecutor | undefined;
      assert.ok(executor);
      return (await executor(['shell', 'echo', 'android'])).stdout;
    },
  );

  const appleTask = withRequestPlatformProviderScope(
    context(IOS_SIMULATOR, 'ios-session', 'req-apple'),
    {
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
    async () =>
      (await runXcrun(buildSimctlArgsForDevice(IOS_SIMULATOR, ['list', 'devices', '-j']))).stdout,
  );

  assert.deepEqual(await Promise.all([androidTask, appleTask]), ['android-ok', 'apple-ok']);
  assert.deepEqual(androidCalls, [`android-session:${ANDROID_EMULATOR.id}:shell echo android`]);
  assert.deepEqual(appleCalls, [`ios-session:${IOS_SIMULATOR.id}:list devices -j`]);
});

test('web provider scope uses the context device', async () => {
  const calls: string[] = [];
  const webProvider = makeWebProvider({
    async open(target) {
      calls.push(`open:${target}`);
    },
  });

  await withRequestPlatformProviderScope(
    context(WEB_DESKTOP_DEVICE, 'web-session'),
    {
      webProvider: ({ device, session }) => {
        calls.push(`${session?.name}:${device.id}`);
        return webProvider;
      },
      linuxToolProvider: () => {
        throw new Error('Linux provider should not apply to a web session');
      },
    },
    async () => await (await resolveWebProvider()).open('https://example.test'),
  );

  assert.deepEqual(calls, ['web-session:agent-browser-chrome', 'open:https://example.test']);
});

test('generic Apple runner provider cannot borrow local recording authority', async () => {
  await withRequestPlatformProviderScope(
    context(MACOS_DEVICE, 'macos-session'),
    {
      appleRunnerProvider: () => ({ runCommand: async () => ({}), hasLiveSession: () => true }),
    },
    async () => {
      const transport = resolveAppleRunnerScreenRecordingTransport();
      assert.equal(transport.authority, 'scoped-provider');
      assert.equal(transport.available, false);
    },
  );
});

test('Apple runner recording authority stays exact across recreated scopes', async () => {
  let activeSessionId: string | undefined;
  const transport: AppleRunnerScreenRecordingTransport = Object.freeze({
    authority: 'scoped-provider',
    available: true,
    start: async () => {
      activeSessionId = 'provider-runner-session-1';
      return { runnerSessionId: activeSessionId };
    },
    inspect: async (device, runnerSessionId) =>
      device.id === MACOS_DEVICE.id && runnerSessionId === activeSessionId
        ? 'owned-alive'
        : 'ownership-lost',
    stop: async ({ device, runnerSessionId }) => {
      assert.equal(device.id, MACOS_DEVICE.id);
      assert.equal(runnerSessionId, activeSessionId);
      activeSessionId = undefined;
    },
  });
  const providers = {
    appleRunnerProvider: () => ({ runCommand: async () => ({}), hasLiveSession: () => true }),
    appleRunnerScreenRecordingTransport: () => transport,
  };
  const providerContext = context(MACOS_DEVICE, 'macos-session');
  const runnerSessionId = await withRequestPlatformProviderScope(
    providerContext,
    providers,
    async () => {
      const resolved = resolveAppleRunnerScreenRecordingTransport();
      assert.equal(resolved, transport);
      return (
        await resolved.start({
          device: MACOS_DEVICE,
          appBundleId: 'com.example.app',
          outputPath: '/tmp/capture.mp4',
        })
      ).runnerSessionId;
    },
  );

  await withRequestPlatformProviderScope(providerContext, providers, async () => {
    const resolved = resolveAppleRunnerScreenRecordingTransport();
    assert.equal(await resolved.inspect(MACOS_DEVICE, runnerSessionId), 'owned-alive');
    assert.equal(await resolved.inspect(MACOS_DEVICE, 'replacement-session'), 'ownership-lost');
    await resolved.stop({ device: MACOS_DEVICE, runnerSessionId });
  });
});

test('explicit web provider scope uses a sessionless context', async () => {
  const seenDevices: string[] = [];

  await withRequestPlatformProviderScope(
    { device: WEB_DESKTOP_DEVICE, requestId: 'req-web' },
    {
      webProvider: ({ device, session }) => {
        seenDevices.push(`${session?.name ?? 'none'}:${device.id}`);
        return makeWebProvider();
      },
      appleToolProvider: () => {
        throw new Error('Apple provider should not apply to a web request');
      },
    },
    async () => await (await resolveWebProvider()).snapshot(),
  );

  assert.deepEqual(seenDevices, ['none:agent-browser-chrome']);
});

function context(
  device: PlatformProviderRequestContext['device'],
  sessionName = 'default',
  requestId = 'req-provider-scope',
): PlatformProviderRequestContext {
  return {
    device,
    session: { name: sessionName, device },
    requestId,
  };
}

async function withRequestPlatformProviderScope<T>(
  providerContext: PlatformProviderRequestContext,
  providers: PlatformProviderResolvers,
  task: (scope: RequestPlatformProviderScope) => Promise<T>,
): Promise<T> {
  const scoped = createRequestPlatformProviders({ providers });
  return await scoped.run(providerContext, task);
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
