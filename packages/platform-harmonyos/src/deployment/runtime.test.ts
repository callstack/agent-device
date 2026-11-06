import { expect, test, vi } from 'vitest';
import type {
  HostCommandRunner,
  HostCommandResult,
} from '@agent-device/contracts/platform-runtime-host';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { createHarmonyAppDeploymentOperations, harmonyAppDeploymentFacts } from './runtime.ts';

const device: DeviceInfo = {
  platform: 'harmonyos',
  id: 'harmony-deployment-fact',
  name: 'HarmonyOS',
  kind: 'emulator',
  target: 'mobile',
  booted: true,
};

test.each([
  ['emulator', device, true],
  ['physical device', { ...device, kind: 'device' as const }, true],
  ['invalid simulator kind', { ...device, kind: 'simulator' as const }, false],
] as const)(
  'classifies HarmonyOS deployment facts for the %s denominator cell',
  (_name, runtimeDevice, deployAvailable) => {
    const facts = harmonyAppDeploymentFacts(runtimeDevice);
    expect(facts.deployApp.available).toBe(deployAvailable);
    expect(facts.uninstallApp.available).toBe(deployAvailable);
    if (!deployAvailable) {
      expect(facts.deployApp).toMatchObject({ reason: 'unsupported-device-kind' });
      expect(facts.uninstallApp).toMatchObject({ reason: 'unsupported-device-kind' });
    }
    for (const fact of [
      facts.materializeAppSource,
      facts.deployMaterializedApp,
      facts.sendPushNotification,
    ]) {
      expect(fact).toMatchObject({ available: false, reason: 'unsupported-platform-leaf' });
    }
  },
);

test('exposes HarmonyOS deployApp and uninstallApp after fact admission', async () => {
  const run = vi.fn(async (request: { executable: string; args: readonly string[] }) => ({
    stdout:
      request.executable === 'unzip'
        ? '{"app":{"bundleName":"com.example.app"}}'
        : request.args.includes('dump')
          ? '{"hapModuleInfos":[{"mainElementName":"MainAbility","moduleName":"entry"}]}'
          : '',
    stderr: '',
    exitCode: 0,
  }));
  const commands = { which: async () => undefined, run } as HostCommandRunner;
  const signal = new AbortController().signal;
  const operations = createHarmonyAppDeploymentOperations({ commands, device, signal });
  await operations.deployApp?.({
    app: 'com.example.app',
    appPath: '/tmp/app.hap',
    replaceExisting: false,
  });
  await operations.deployApp?.({
    app: 'com.example.app',
    appPath: '/tmp/app.hap',
    replaceExisting: true,
  });
  expect(run).toHaveBeenCalledWith(
    expect.objectContaining({
      executable: 'hdc',
      args: ['-t', device.id, 'install', '-r', '/tmp/app.hap'],
    }),
    signal,
  );
  expect(run).toHaveBeenCalledWith(
    expect.objectContaining({
      executable: 'hdc',
      args: [
        '-t',
        device.id,
        'shell',
        'aa',
        'start',
        '-b',
        'com.example.app',
        '-m',
        'entry',
        '-a',
        'MainAbility',
      ],
    }),
    signal,
  );
  expect(operations).not.toHaveProperty('materializeAppSource');
  expect(
    createHarmonyAppDeploymentOperations({
      commands,
      device: { ...device, kind: 'simulator' },
      signal,
    }),
  ).toEqual({});
});

const installedDump: HostCommandResult = {
  stdout: '{"hapModuleInfos":[{"mainElementName":"MainAbility","moduleName":"entry"}]}',
  stderr: '',
  exitCode: 0,
};

test('uninstall removes an installed HarmonyOS bundle through bm uninstall', async () => {
  const run = vi.fn(async () => installedDump);
  const commands = { which: async () => undefined, run } as HostCommandRunner;
  const signal = new AbortController().signal;
  const operations = createHarmonyAppDeploymentOperations({ commands, device, signal });

  await expect(operations.uninstallApp?.({ app: 'com.example.app' })).resolves.toEqual({
    wasInstalled: true,
    packageName: 'com.example.app',
  });
  expect(run).toHaveBeenCalledTimes(2);
  expect(run).toHaveBeenNthCalledWith(
    1,
    expect.objectContaining({
      executable: 'hdc',
      args: ['-t', device.id, 'shell', 'bm', 'dump', '-n', 'com.example.app'],
    }),
    signal,
  );
  expect(run).toHaveBeenNthCalledWith(
    2,
    expect.objectContaining({
      executable: 'hdc',
      args: ['-t', device.id, 'shell', 'bm', 'uninstall', '-n', 'com.example.app'],
    }),
    signal,
  );
});

test.each([
  ['a failed dump', { stdout: '[Fail]bundle not installed', stderr: '', exitCode: 1 }],
  ['a dump without a JSON record', { stdout: '', stderr: '', exitCode: 0 }],
] as const)('uninstall reports nothing removed for %s', async (_name, dump) => {
  const run = vi.fn(async () => dump as HostCommandResult);
  const commands = { which: async () => undefined, run } as HostCommandRunner;
  const signal = new AbortController().signal;
  const operations = createHarmonyAppDeploymentOperations({ commands, device, signal });

  await expect(operations.uninstallApp?.({ app: 'com.example.app' })).resolves.toEqual({
    wasInstalled: false,
  });
  expect(run).toHaveBeenCalledTimes(1);
  expect(run).toHaveBeenCalledWith(expect.objectContaining({ allowFailure: true }), signal);
});

test('uninstall refuses a blank bundle name', async () => {
  const run = vi.fn();
  const commands = { which: async () => undefined, run } as HostCommandRunner;
  const signal = new AbortController().signal;
  const operations = createHarmonyAppDeploymentOperations({ commands, device, signal });

  await expect(operations.uninstallApp?.({ app: '   ' })).rejects.toMatchObject({
    code: 'INVALID_ARGS',
  });
  expect(run).not.toHaveBeenCalled();
});
