import { expect, test } from 'vitest';
import type { DeviceInfo } from '@agent-device/kernel/device';
import type { Interactor } from './interactor-types.ts';
import type { OpenApplicationInput } from './application-lifecycle-runtime.ts';
import {
  bindDirectApplicationLifecycle,
  bindLocalApplicationLifecycleInteractor,
  invokeApplicationOpen,
} from './application-lifecycle-interaction.ts';

const IOS_SIMULATOR: DeviceInfo = {
  platform: 'apple',
  appleOs: 'ios',
  id: 'ios-simulator',
  name: 'iPhone',
  kind: 'simulator',
  booted: true,
};

const IPADOS_SIMULATOR: DeviceInfo = {
  ...IOS_SIMULATOR,
  appleOs: 'ipados',
  id: 'ipados-simulator',
  name: 'iPad',
};

const TVOS_SIMULATOR: DeviceInfo = {
  ...IOS_SIMULATOR,
  appleOs: 'tvos',
  id: 'tvos-simulator',
  name: 'Apple TV',
};

const LINUX_DEVICE: DeviceInfo = {
  platform: 'linux',
  id: 'linux-local',
  name: 'Linux',
  kind: 'device',
  booted: true,
};

const IOS_PHYSICAL_DEVICE: DeviceInfo = {
  ...IOS_SIMULATOR,
  id: 'ios-device',
  kind: 'device',
};

function interactorWithOpen(open: Interactor['open'] = async () => undefined): Interactor {
  return {
    open,
    openDevice: async () => undefined,
    close: async () => undefined,
    setSetting: async () => undefined,
  } as unknown as Interactor;
}

function openInput(overrides: Partial<OpenApplicationInput> = {}): OpenApplicationInput {
  return {
    target: 'com.example.app',
    positionals: ['com.example.app'],
    appBundleId: 'com.example.app',
    surface: 'app',
    hasExistingSession: false,
    relaunch: false,
    prewarmRunnerBeforeOpen: false,
    enableTestIme: false,
    stateDir: '/state',
    runtimeHints: {},
    execution: {},
    ...overrides,
  };
}

test('direct lifecycle owners preserve the daemon runtime launch URL follow-up', async () => {
  const calls: Array<{ app: string; options: unknown }> = [];
  const interactor = interactorWithOpen(async (app, options) => {
    calls.push({ app, options });
  });
  const binding = bindLocalApplicationLifecycleInteractor({
    device: IOS_SIMULATOR,
    signal: new AbortController().signal,
    resolveInteractor: async () => interactor,
  });
  const lifecycle = bindDirectApplicationLifecycle({
    binding,
    owner: 'iOS Simulator',
    openTargetIdentity: 'app-name',
  });

  await lifecycle.openApplication(
    openInput({
      runtimeLaunchUrl: 'example://after-open',
      execution: {
        clearAppState: true,
        launchArgs: ['--first-launch'],
        launchEnvironment: { MODE: 'test' },
      },
    }),
  );

  expect(calls.map(({ app }) => app)).toEqual(['com.example.app', 'example://after-open']);
  expect(calls[0]?.options).toMatchObject({
    appBundleId: 'com.example.app',
    launchArgs: ['--first-launch'],
    launchEnvironment: { MODE: 'test' },
  });
  expect(calls[1]?.options).toMatchObject({ appBundleId: 'com.example.app' });
  expect(calls[1]?.options).toHaveProperty('launchArgs', undefined);
  expect(calls[1]?.options).toHaveProperty('launchEnvironment', undefined);
});

test.each([
  {
    name: 'more than two positionals',
    device: IOS_SIMULATOR,
    positionals: ['com.example.app', 'example://one', 'example://two'],
    execution: {},
    message: /at most two arguments/,
  },
  {
    name: 'launch console without an app',
    device: IOS_SIMULATOR,
    positionals: [],
    execution: { launchConsole: 'stdout' },
    message: /launch-console requires an app target/,
  },
  {
    name: 'launch arguments without an app',
    device: IOS_SIMULATOR,
    positionals: [],
    execution: { launchArgs: ['--flag'] },
    message: /launch-args requires an app target/,
  },
  {
    name: 'launch environment without an app',
    device: IOS_SIMULATOR,
    positionals: [],
    execution: { launchEnvironment: { MODE: 'test' } },
    message: /launch-env requires an app target/,
  },
  {
    name: 'launch environment on a physical iOS device',
    device: IOS_PHYSICAL_DEVICE,
    positionals: ['com.example.app'],
    execution: { launchEnvironment: { MODE: 'test' } },
    message: /only for iOS Simulator/,
  },
  {
    name: 'launch environment on a non-iOS Apple simulator',
    device: TVOS_SIMULATOR,
    positionals: ['com.example.app'],
    execution: { launchEnvironment: { MODE: 'test' } },
    message: /only for iOS Simulator/,
  },
  {
    name: 'launch environment on Linux',
    device: LINUX_DEVICE,
    positionals: ['org.example.App'],
    execution: { launchEnvironment: { MODE: 'test' } },
    message: /only for iOS Simulator/,
  },
  {
    name: 'launch console outside an iOS simulator',
    device: LINUX_DEVICE,
    positionals: ['org.example.App'],
    execution: { launchConsole: 'stdout' },
    message: /iOS simulator/i,
  },
  {
    name: 'launch arguments on Linux',
    device: LINUX_DEVICE,
    positionals: ['org.example.App'],
    execution: { launchArgs: ['--flag'] },
    message: /not supported on Linux/,
  },
  {
    name: 'a URL in the app position when a second URL is present',
    device: IOS_SIMULATOR,
    positionals: ['example://first', 'example://second'],
    execution: {},
    message: /requires an app target as the first argument/,
  },
  {
    name: 'an invalid second URL',
    device: IOS_SIMULATOR,
    positionals: ['com.example.app', 'not-a-url'],
    execution: {},
    message: /requires a valid URL target/,
  },
  {
    name: 'launch console with a direct URL pair',
    device: IOS_SIMULATOR,
    positionals: ['com.example.app', 'example://home'],
    execution: { launchConsole: 'stdout' },
    message: /direct app/i,
  },
  {
    name: 'clear app state with a deep-link target',
    device: IOS_SIMULATOR,
    positionals: ['example://home'],
    execution: { clearAppState: true },
    message: /requires an app target, not a deep link/,
  },
])('rejects invalid open input: $name', async ({ device, positionals, execution, message }) => {
  await expect(
    invokeApplicationOpen({
      device,
      interactor: interactorWithOpen(),
      positionals,
      execution,
    }),
  ).rejects.toThrow(message);
});

test('iPadOS Simulator accepts launch environment for app launches', async () => {
  const calls: Array<{ app: string; options: unknown }> = [];
  const lifecycle = bindDirectApplicationLifecycle({
    binding: bindLocalApplicationLifecycleInteractor({
      device: IPADOS_SIMULATOR,
      signal: new AbortController().signal,
      resolveInteractor: async () =>
        interactorWithOpen(async (app, options) => {
          calls.push({ app, options });
        }),
    }),
    owner: 'iPadOS Simulator',
    openTargetIdentity: 'bundle-id',
  });

  await lifecycle.openApplication(
    openInput({ execution: { launchEnvironment: { MODE: 'test' } } }),
  );

  expect(calls).toHaveLength(1);
  expect(calls[0]?.options).toMatchObject({ launchEnvironment: { MODE: 'test' } });
});
