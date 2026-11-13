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

/** Answers each call in order; the last answer repeats when a script runs past its end. */
function scriptAnswers(answers: readonly HostCommandResult[]) {
  let next = 0;
  return async (): Promise<HostCommandResult> => answers[Math.min(next++, answers.length - 1)]!;
}

const bundleInventory = (entries: string[]): HostCommandResult => ({
  stdout: [...entries, ''].join('\n'),
  stderr: '',
  exitCode: 0,
});

const uninstallAnswer: HostCommandResult = {
  stdout: 'uninstall bundle successfully.',
  stderr: '',
  exitCode: 0,
};

/** `bm dump -a` inventory answers: one bundle name per line, the shared parseHarmonyBundleList shape. */
const installedInventory = bundleInventory(['com.example.other', 'com.example.app']);
const absentInventory = bundleInventory(['com.example.other']);

/**
 * Shapes recorded on physical hardware: bm prints its per-bundle failures into
 * stdout while the host exit code stays 0, so this answer is an unknown read,
 * never a proof of absence.
 */
const unknownInventoryRead: HostCommandResult = {
  stdout: 'error: failed to get information and the parameters may be wrong.',
  stderr: '',
  exitCode: 0,
};

test('uninstall removes an installed HarmonyOS bundle through bm uninstall', async () => {
  const run = vi.fn(scriptAnswers([installedInventory, uninstallAnswer, absentInventory]));
  const commands = { which: async () => undefined, run } as HostCommandRunner;
  const signal = new AbortController().signal;
  const operations = createHarmonyAppDeploymentOperations({ commands, device, signal });

  await expect(operations.uninstallApp?.({ app: 'com.example.app' })).resolves.toEqual({
    wasInstalled: true,
    packageName: 'com.example.app',
  });
  expect(run).toHaveBeenCalledTimes(3);
  expect(run).toHaveBeenNthCalledWith(
    1,
    expect.objectContaining({
      executable: 'hdc',
      args: ['-t', device.id, 'shell', 'bm', 'dump', '-a'],
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
  expect(run).toHaveBeenNthCalledWith(
    3,
    expect.objectContaining({
      executable: 'hdc',
      args: ['-t', device.id, 'shell', 'bm', 'dump', '-a'],
    }),
    signal,
  );
});

test('uninstall reports an absent bundle without uninstalling', async () => {
  const run = vi.fn(scriptAnswers([absentInventory]));
  const commands = { which: async () => undefined, run } as HostCommandRunner;
  const signal = new AbortController().signal;
  const operations = createHarmonyAppDeploymentOperations({ commands, device, signal });

  await expect(operations.uninstallApp?.({ app: 'com.example.app' })).resolves.toEqual({
    wasInstalled: false,
  });
  expect(run).toHaveBeenCalledTimes(1);
  expect(run).not.toHaveBeenCalledWith(
    expect.objectContaining({ args: expect.arrayContaining(['uninstall']) }),
    signal,
  );
});

test('uninstall refuses to claim removal when the inventory still lists the bundle', async () => {
  const run = vi.fn(scriptAnswers([installedInventory, uninstallAnswer, installedInventory]));
  const commands = { which: async () => undefined, run } as HostCommandRunner;
  const signal = new AbortController().signal;
  const operations = createHarmonyAppDeploymentOperations({ commands, device, signal });

  await expect(operations.uninstallApp?.({ app: 'com.example.app' })).rejects.toMatchObject({
    code: 'COMMAND_FAILED',
    message: 'com.example.app is still installed after bm uninstall',
    details: { stdout: 'uninstall bundle successfully.' },
  });
  expect(run).toHaveBeenCalledTimes(3);
});

test('uninstall refuses an inventory read it cannot interpret', async () => {
  const run = vi.fn(scriptAnswers([unknownInventoryRead]));
  const commands = { which: async () => undefined, run } as HostCommandRunner;
  const signal = new AbortController().signal;
  const operations = createHarmonyAppDeploymentOperations({ commands, device, signal });

  await expect(operations.uninstallApp?.({ app: 'com.example.app' })).rejects.toMatchObject({
    code: 'COMMAND_FAILED',
    message: 'Could not read the installed bundle inventory',
  });
  expect(run).toHaveBeenCalledTimes(1);
  expect(run).not.toHaveBeenCalledWith(
    expect.objectContaining({ args: expect.arrayContaining(['uninstall']) }),
    signal,
  );
});

test('uninstall refuses to claim removal when the inventory probe exits non-zero', async () => {
  const run = vi.fn(
    scriptAnswers([
      { stdout: '[Fail]Device not connected', stderr: '[Fail]Device not connected', exitCode: 1 },
    ]),
  );
  const commands = { which: async () => undefined, run } as HostCommandRunner;
  const signal = new AbortController().signal;
  const operations = createHarmonyAppDeploymentOperations({ commands, device, signal });

  await expect(operations.uninstallApp?.({ app: 'com.example.app' })).rejects.toMatchObject({
    code: 'COMMAND_FAILED',
    message: 'Could not read the installed bundle inventory',
    details: { processExitError: true, exitCode: 1 },
  });
  expect(run).toHaveBeenCalledTimes(1);
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
