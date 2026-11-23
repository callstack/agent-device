import { expect, test } from 'vitest';
import type { DeviceInfo } from '@agent-device/kernel/device';
import type { Interactor } from './interactor-types.ts';
import type { OpenApplicationInput } from './application-lifecycle-runtime.ts';
import {
  bindDirectApplicationLifecycle,
  bindLocalApplicationLifecycleInteractor,
  bindLocalDirectApplicationLifecycle,
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
    closeBeforeRelaunch: true,
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

/** An interactor that records each open and close it receives, in order. */
function lifecycleRecordingInteractor(calls: string[]): Interactor {
  return {
    open: async (app: string, options?: { terminateRunningApp?: boolean }) => {
      calls.push(`open ${app} terminate=${String(options?.terminateRunningApp)}`);
    },
    openDevice: async () => undefined,
    close: async (app: string) => {
      calls.push(`close ${app}`);
    },
    setSetting: async () => undefined,
  } as unknown as Interactor;
}

// The local direct owners (Linux, web, HarmonyOS, Vega) do not replace a running app on
// open, so a relaunch that reached only `open` left the app running as it was.
test('a local direct owner closes the running app before a relaunch open', async () => {
  const calls: string[] = [];
  const lifecycle = bindLocalDirectApplicationLifecycle({
    owner: 'Linux',
    openTargetIdentity: 'app-name',
    host: { resolve: async () => lifecycleRecordingInteractor(calls) },
    device: LINUX_DEVICE,
    signal: new AbortController().signal,
  });

  await lifecycle.openApplication(
    openInput({ target: 'gedit', positionals: ['gedit'], appBundleId: undefined, relaunch: true }),
  );
  await lifecycle.openApplication(
    openInput({ target: 'gedit', positionals: ['gedit'], appBundleId: undefined }),
  );

  expect(calls).toEqual([
    'close gedit',
    'open gedit terminate=undefined',
    'open gedit terminate=undefined',
  ]);
});

test('an owner whose open restarts the app receives the relaunch as terminateRunningApp', async () => {
  const calls: string[] = [];
  const lifecycle = bindDirectApplicationLifecycle({
    binding: bindProviderApplicationLifecycleInteractor({
      device: IOS_SIMULATOR,
      signal: new AbortController().signal,
      resolveInteractor: () => lifecycleRecordingInteractor(calls),
    }),
    owner: 'provider',
    openTargetIdentity: 'bundle-id',
    closeBeforeRelaunch: false,
  });

  await lifecycle.openApplication(openInput({ relaunch: true }));
  await lifecycle.openApplication(openInput());

  expect(calls).toEqual([
    'open com.example.app terminate=true',
    'open com.example.app terminate=false',
  ]);
});

test('a foreground read naming the open target marks the outcome and still dispatches', async () => {
  const calls: string[] = [];
  const reads: string[] = [];
  const lifecycle = bindLocalDirectApplicationLifecycle({
    owner: 'Linux',
    openTargetIdentity: 'bundle-id',
    host: { resolve: async () => lifecycleRecordingInteractor(calls) },
    device: LINUX_DEVICE,
    signal: new AbortController().signal,
    readForegroundBundle: async () => {
      reads.push('com.example.app');
      return 'com.example.app';
    },
  });

  const outcome = await lifecycle.openApplication(openInput());

  expect(outcome).toMatchObject({ alreadyForeground: true });
  expect(reads).toEqual(['com.example.app']);
  // The read only informs the caller: the dispatch keeps its idempotent semantics.
  expect(calls).toEqual(['open com.example.app terminate=undefined']);
});

test('a foreground read naming another app claims nothing about the open', async () => {
  const calls: string[] = [];
  const lifecycle = bindLocalDirectApplicationLifecycle({
    owner: 'Linux',
    openTargetIdentity: 'bundle-id',
    host: { resolve: async () => lifecycleRecordingInteractor(calls) },
    device: LINUX_DEVICE,
    signal: new AbortController().signal,
    readForegroundBundle: async () => 'com.other.app',
  });

  const outcome = await lifecycle.openApplication(openInput());

  expect(outcome.alreadyForeground).toBeUndefined();
  expect(calls).toEqual(['open com.example.app terminate=undefined']);
});

test('a failing foreground read does not fail the open', async () => {
  const calls: string[] = [];
  const lifecycle = bindLocalDirectApplicationLifecycle({
    owner: 'Linux',
    openTargetIdentity: 'bundle-id',
    host: { resolve: async () => lifecycleRecordingInteractor(calls) },
    device: LINUX_DEVICE,
    signal: new AbortController().signal,
    readForegroundBundle: async () => {
      throw new Error('hdc read failed');
    },
  });

  const outcome = await lifecycle.openApplication(openInput());

  expect(outcome.alreadyForeground).toBeUndefined();
  expect(calls).toEqual(['open com.example.app terminate=undefined']);
});

test('a relaunch open does not consult the foreground read', async () => {
  const calls: string[] = [];
  let reads = 0;
  const lifecycle = bindLocalDirectApplicationLifecycle({
    owner: 'Linux',
    openTargetIdentity: 'bundle-id',
    host: { resolve: async () => lifecycleRecordingInteractor(calls) },
    device: LINUX_DEVICE,
    signal: new AbortController().signal,
    readForegroundBundle: async () => {
      reads += 1;
      return 'com.example.app';
    },
  });

  await lifecycle.openApplication(openInput({ relaunch: true }));

  expect(reads).toBe(0);
  expect(calls).toEqual(['close com.example.app', 'open com.example.app terminate=undefined']);
});

test('a clear-app-state or --activity open does not consult the foreground read', async () => {
  const calls: string[] = [];
  let reads = 0;
  const lifecycle = bindLocalDirectApplicationLifecycle({
    owner: 'Linux',
    openTargetIdentity: 'bundle-id',
    host: { resolve: async () => lifecycleRecordingInteractor(calls) },
    device: LINUX_DEVICE,
    signal: new AbortController().signal,
    readForegroundBundle: async () => {
      reads += 1;
      return 'com.example.app';
    },
  });

  // Each open stops or replaces the running app, so a pre-dispatch read of the same bundle
  // would claim a re-activation the open itself is about to end (#4860 review).
  await lifecycle.openApplication(openInput({ execution: { clearAppState: true } }));
  await lifecycle.openApplication(openInput({ execution: { activity: 'EntryAbility' } }));

  expect(reads).toBe(0);
  expect(calls).toEqual([
    'open com.example.app terminate=undefined',
    'open com.example.app terminate=undefined',
  ]);
});

test('a URL pair open does not consult the foreground read', async () => {
  let reads = 0;
  const lifecycle = bindLocalDirectApplicationLifecycle({
    owner: 'Linux',
    openTargetIdentity: 'bundle-id',
    host: { resolve: async () => lifecycleRecordingInteractor([]) },
    device: LINUX_DEVICE,
    signal: new AbortController().signal,
    readForegroundBundle: async () => {
      reads += 1;
      return 'com.example.app';
    },
  });

  await lifecycle.openApplication(
    openInput({ positionals: ['com.example.app', 'example://home'] }),
  );

  expect(reads).toBe(0);
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

test('provider interactor resolution refuses launch-console before a relaunch close', async () => {
  const calls: string[] = [];
  const binding = bindProviderApplicationLifecycleInteractor({
    device: IOS_SIMULATOR,
    signal: new AbortController().signal,
    resolveInteractor: () => {
      calls.push('resolve');
      return interactorWithOpen();
    },
  });
  const lifecycle = bindDirectApplicationLifecycle({
    binding,
    owner: 'provider',
    openTargetIdentity: 'bundle-id',
    closeBeforeRelaunch: true,
  });
  await expect(
    lifecycle.openApplication(
      openInput({ relaunch: true, execution: { launchConsole: '/tmp/app.log' } }),
    ),
  ).rejects.toMatchObject({
    code: 'UNSUPPORTED_OPERATION',
    details: { reason: 'launch-console-owner-unadmitted', deviceId: IOS_SIMULATOR.id },
  });
  expect(calls).toEqual([]);
});
