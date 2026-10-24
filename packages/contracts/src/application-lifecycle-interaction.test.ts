import { expect, test } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import type { DeviceInfo } from '@agent-device/kernel/device';
import type { Interactor } from './interactor-types.ts';
import type { OpenApplicationInput } from './application-lifecycle-runtime.ts';
import {
  bindDirectApplicationLifecycle,
  bindLocalApplicationLifecycleInteractor,
  bindProviderApplicationLifecycleInteractor,
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

const LINUX_DEVICE: DeviceInfo = {
  platform: 'linux',
  id: 'linux-local',
  name: 'Linux',
  kind: 'device',
  booted: true,
};

const WEB_DEVICE: DeviceInfo = {
  platform: 'web',
  id: 'web-local',
  name: 'Browser',
  kind: 'device',
  booted: true,
};

function interactorWithOpen(
  open: Interactor['open'] = async () => undefined,
  overrides: Partial<Pick<Interactor, 'close' | 'setSetting'>> = {},
): Interactor {
  return {
    open,
    openDevice: async () => undefined,
    close: async () => undefined,
    setSetting: async () => undefined,
    ...overrides,
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
    device: WEB_DEVICE,
    signal: new AbortController().signal,
    resolveInteractor: async () => interactor,
  });
  const lifecycle = bindDirectApplicationLifecycle({
    binding,
    owner: 'Linux',
    openTargetIdentity: 'app-name',
  });

  await lifecycle.openApplication(
    openInput({
      runtimeLaunchUrl: 'example://after-open',
      execution: { clearAppState: true, launchArgs: ['--first-launch'] },
    }),
  );

  expect(calls.map(({ app }) => app)).toEqual(['com.example.app', 'example://after-open']);
  expect(calls[0]?.options).toMatchObject({
    appBundleId: 'com.example.app',
    launchArgs: ['--first-launch'],
  });
  expect(calls[1]?.options).toMatchObject({ appBundleId: 'com.example.app' });
  expect(calls[1]?.options).toHaveProperty('launchArgs', undefined);
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
  {
    name: 'launch console with a deep-link app target',
    device: IOS_SIMULATOR,
    positionals: ['example://home'],
    execution: { launchConsole: 'stdout' },
    message: /direct app/i,
  },
  {
    name: 'network capture with a deep-link app target',
    device: IOS_SIMULATOR,
    positionals: ['example://home'],
    execution: { networkCapturePath: '/sessions/one/network.jsonl' },
    message: /direct app launch/,
  },
  {
    name: 'network capture without an app',
    device: IOS_SIMULATOR,
    positionals: [],
    execution: { networkCapturePath: '/sessions/one/network.jsonl' },
    message: /direct app launch/,
  },
  {
    name: 'network capture with a direct URL pair',
    device: IOS_SIMULATOR,
    positionals: ['com.example.app', 'example://home'],
    execution: { networkCapturePath: '/sessions/one/network.jsonl' },
    message: /direct app launch/,
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

for (const [name, execution, reason] of [
  [
    'capture',
    { networkCapturePath: '/sessions/one/network.jsonl' },
    'network-capture-owner-unadmitted',
  ],
  [
    'launch console',
    { launchConsole: '/tmp/launch-console.log' },
    'launch-console-owner-unadmitted',
  ],
] as const) {
  test(`the generic provider lifecycle refuses ${name} on a provider-shaped iOS simulator before touching the device`, async () => {
    // Limrun's iOS simulator has the local shape but dispatches through this generic provider
    // lifecycle, whose interactor would silently ignore the request; with closeBeforeRelaunch it
    // would also close the running app first. Binding a provider interactor derives no
    // local-simulator capability, so the open must refuse with the typed code and reason before
    // its relaunch close or open dispatch runs.
    const calls: string[] = [];
    const binding = bindProviderApplicationLifecycleInteractor({
      device: IOS_SIMULATOR,
      signal: new AbortController().signal,
      resolveInteractor: () =>
        interactorWithOpen(
          async () => {
            calls.push('open');
          },
          {
            close: async () => {
              calls.push('close');
            },
          },
        ),
    });
    const lifecycle = bindDirectApplicationLifecycle({
      binding,
      owner: 'Provider',
      openTargetIdentity: 'bundle-id',
      closeBeforeRelaunch: true,
    });
    const refusal = await lifecycle.openApplication(openInput({ relaunch: true, execution })).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(refusal).toBeInstanceOf(AppError);
    expect((refusal as AppError).code).toBe('UNSUPPORTED_OPERATION');
    expect((refusal as AppError).details?.reason).toBe(reason);
    expect(calls).toEqual([]);
  });

  test(`a local binding on a non-simulator device refuses ${name} with the typed code`, async () => {
    const binding = bindLocalApplicationLifecycleInteractor({
      device: LINUX_DEVICE,
      signal: new AbortController().signal,
      resolveInteractor: async () => interactorWithOpen(),
    });
    const lifecycle = bindDirectApplicationLifecycle({
      binding,
      owner: 'Linux',
      openTargetIdentity: 'app-name',
    });
    const refusal = await lifecycle.openApplication(openInput({ execution })).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(refusal).toBeInstanceOf(AppError);
    expect((refusal as AppError).code).toBe('UNSUPPORTED_OPERATION');
    expect((refusal as AppError).details?.reason).toBe(reason);
  });
}

test('a URL-pair relaunch carrying capture and clear-app-state is refused before any close', async () => {
  // `open <bundle> <scheme://x> --relaunch --clear-app-state --capture-network`: the launch-only
  // options cannot ride a URL pair, and admission answers that from positionals and execution
  // alone — before the closeBeforeRelaunch owner closes the running app.
  const calls: string[] = [];
  const binding = bindLocalApplicationLifecycleInteractor({
    device: IOS_SIMULATOR,
    signal: new AbortController().signal,
    resolveInteractor: async () =>
      interactorWithOpen(
        async () => {
          calls.push('open');
        },
        {
          close: async () => {
            calls.push('close');
          },
          setSetting: async () => {
            calls.push('setSetting');
          },
        },
      ),
  });
  const lifecycle = bindDirectApplicationLifecycle({
    binding,
    owner: 'Local',
    openTargetIdentity: 'bundle-id',
    closeBeforeRelaunch: true,
  });
  const refusal = await lifecycle
    .openApplication(
      openInput({
        relaunch: true,
        positionals: ['com.example.app', 'example://deal'],
        execution: {
          clearAppState: true,
          networkCapturePath: '/sessions/one/network.jsonl',
        },
      }),
    )
    .then(
      () => undefined,
      (error: unknown) => error,
    );
  expect(refusal).toBeInstanceOf(AppError);
  expect((refusal as AppError).code).toBe('INVALID_ARGS');
  expect((refusal as AppError).message).toMatch(/direct app launch/);
  expect(calls).toEqual([]);
});

test('passes the session capture file to the interactor on a capture launch', async () => {
  let seen: Parameters<Interactor['open']>[1];
  await invokeApplicationOpen({
    device: IOS_SIMULATOR,
    interactor: interactorWithOpen(async (_app, options) => {
      seen = options;
    }),
    positionals: ['com.example.app'],
    execution: { networkCapturePath: '/sessions/one/network.jsonl' },
  });
  expect(seen).toMatchObject({ networkCapturePath: '/sessions/one/network.jsonl' });
});
