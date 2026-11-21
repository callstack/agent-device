import { expect, test } from 'vitest';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { createHarmonyHostStub } from '../toolbox.fixtures.ts';
import type { HarmonyCommandResult } from '../command-host.ts';
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
  const stub = createHarmonyHostStub({
    respond: (executable, args) => ({
      stdout:
        executable === 'unzip'
          ? '{"app":{"bundleName":"com.example.app"}}'
          : args.includes('dump')
            ? '{"hapModuleInfos":[{"mainElementName":"MainAbility","moduleName":"entry"}]}'
            : '',
    }),
  });
  const signal = new AbortController().signal;
  const operations = createHarmonyAppDeploymentOperations({
    toolbox: stub.toolbox,
    device,
    signal,
  });
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

  // Every spawn names the executable and argv the plugin built, on the host it was set up with.
  // The second deploy replaces an existing bundle, which additionally resolves the launch target.
  expect(stub.commands.map((command) => [command.executable, command.args])).toEqual([
    ['unzip', ['-p', '/tmp/app.hap', 'module.json']],
    ['hdc', ['-t', device.id, 'install', '-r', '/tmp/app.hap']],
    ['unzip', ['-p', '/tmp/app.hap', 'module.json']],
    ['hdc', ['-t', device.id, 'install', '-r', '/tmp/app.hap']],
    ['hdc', ['-t', device.id, 'shell', 'bm', 'dump', '-n', 'com.example.app']],
    [
      'hdc',
      [
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
    ],
  ]);
  expect(stub.commands.every((command) => command.signal === signal)).toBe(true);
  expect(operations).not.toHaveProperty('materializeAppSource');
  expect(
    createHarmonyAppDeploymentOperations({
      toolbox: stub.toolbox,
      device: { ...device, kind: 'simulator' },
      signal,
    }),
  ).toEqual({});
});

/** The answers the uninstall tests need, keyed by what the plugin asked the device. */
/**
 * Answers each inventory read in order; the last answer repeats when the script runs past its end,
 * which is how a test keeps the bundle present after the uninstall attempt.
 */
function uninstallResponder(answers: {
  inventories?: readonly (string | Partial<HarmonyCommandResult>)[];
  uninstall?: Partial<HarmonyCommandResult>;
}) {
  const inventories = [...(answers.inventories ?? [])];
  let reads = 0;
  return (_executable: string, args: readonly string[]) => {
    if (args.includes('dump')) {
      const inventory = inventories[Math.min(reads++, inventories.length - 1)] ?? '';
      return typeof inventory === 'string' ? { stdout: inventory } : inventory;
    }
    if (args.includes('uninstall')) return answers.uninstall ?? {};
    return {};
  };
}

/** `bm dump -a` inventory answers: one bundle name per line, the shared parseHarmonyBundleList shape. */
const installedInventory = 'com.example.other\ncom.example.app\n';
const absentInventory = 'com.example.other\n';

/**
 * Shapes recorded on physical hardware: bm prints its per-bundle failures into
 * stdout while the host exit code stays 0, so this answer is an unknown read,
 * never a proof of absence.
 */
const unknownInventoryRead = {
  stdout: 'error: failed to get information and the parameters may be wrong.',
  stderr: '',
  exitCode: 0,
};

test('uninstall removes an installed HarmonyOS bundle through bm uninstall', async () => {
  const stub = createHarmonyHostStub({
    respond: uninstallResponder({
      inventories: [installedInventory, absentInventory],
      uninstall: { stdout: 'uninstall bundle successfully.' },
    }),
  });
  const signal = new AbortController().signal;
  const operations = createHarmonyAppDeploymentOperations({
    toolbox: stub.toolbox,
    device,
    signal,
  });

  await expect(operations.uninstallApp?.({ app: 'com.example.app' })).resolves.toEqual({
    wasInstalled: true,
    packageName: 'com.example.app',
  });
  expect(stub.commands.map((command) => command.args)).toEqual([
    ['-t', device.id, 'shell', 'bm', 'dump', '-a'],
    ['-t', device.id, 'shell', 'bm', 'uninstall', '-n', 'com.example.app'],
    ['-t', device.id, 'shell', 'bm', 'dump', '-a'],
  ]);
});

test('uninstall reports an absent bundle without uninstalling', async () => {
  const stub = createHarmonyHostStub({
    respond: uninstallResponder({ inventories: [absentInventory] }),
  });
  const signal = new AbortController().signal;
  const operations = createHarmonyAppDeploymentOperations({
    toolbox: stub.toolbox,
    device,
    signal,
  });

  await expect(operations.uninstallApp?.({ app: 'com.example.app' })).resolves.toEqual({
    wasInstalled: false,
  });
  expect(stub.commands.map((command) => command.args)).toEqual([
    ['-t', device.id, 'shell', 'bm', 'dump', '-a'],
  ]);
});

test('uninstall refuses to claim removal when the inventory still lists the bundle', async () => {
  const stub = createHarmonyHostStub({
    respond: uninstallResponder({
      inventories: [installedInventory],
      uninstall: { stdout: 'uninstall bundle successfully.' },
    }),
  });
  const signal = new AbortController().signal;
  const operations = createHarmonyAppDeploymentOperations({
    toolbox: stub.toolbox,
    device,
    signal,
  });

  await expect(operations.uninstallApp?.({ app: 'com.example.app' })).rejects.toMatchObject({
    code: 'COMMAND_FAILED',
    message: 'com.example.app is still installed after bm uninstall',
    details: { stdout: 'uninstall bundle successfully.' },
  });
  expect(stub.commands.length).toBe(3);
});

test('uninstall refuses an inventory read it cannot interpret', async () => {
  const stub = createHarmonyHostStub({
    respond: uninstallResponder({ inventories: [unknownInventoryRead] }),
  });
  const signal = new AbortController().signal;
  const operations = createHarmonyAppDeploymentOperations({
    toolbox: stub.toolbox,
    device,
    signal,
  });

  await expect(operations.uninstallApp?.({ app: 'com.example.app' })).rejects.toMatchObject({
    code: 'COMMAND_FAILED',
    message: 'Could not read the installed bundle inventory',
  });
  expect(stub.commands.length).toBe(1);
  expect(stub.commands.some((command) => command.args.includes('uninstall'))).toBe(false);
});

test('uninstall refuses to claim removal when the inventory probe exits non-zero', async () => {
  const stub = createHarmonyHostStub({
    respond: uninstallResponder({
      inventories: [
        {
          stdout: '[Fail]Device not connected',
          stderr: '[Fail]Device not connected',
          exitCode: 1,
        },
      ],
    }),
  });
  const signal = new AbortController().signal;
  const operations = createHarmonyAppDeploymentOperations({
    toolbox: stub.toolbox,
    device,
    signal,
  });

  await expect(operations.uninstallApp?.({ app: 'com.example.app' })).rejects.toMatchObject({
    code: 'COMMAND_FAILED',
    message: 'Could not read the installed bundle inventory',
    details: { processExitError: true, exitCode: 1 },
  });
  expect(stub.commands.length).toBe(1);
});

test('uninstall refuses a blank bundle name', async () => {
  const stub = createHarmonyHostStub();
  const signal = new AbortController().signal;
  const operations = createHarmonyAppDeploymentOperations({
    toolbox: stub.toolbox,
    device,
    signal,
  });

  await expect(operations.uninstallApp?.({ app: '   ' })).rejects.toMatchObject({
    code: 'INVALID_ARGS',
  });
  expect(stub.commands.length).toBe(0);
});
